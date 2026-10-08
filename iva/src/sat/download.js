'use strict';
/**
 * Motor de descarga de CFDI — ahora por SatGo (antes @nodecfdi/sat-ws-descarga-masiva).
 *
 * Mismo flujo oficial del SAT (solicita → verifica → descarga) pero por REST vía
 * SatGo, usando la MISMA e.firma del usuario (ver src/sat/satgo.js). Cambios de
 * negocio pedidos:
 *   · Periodo = del día 1 al ÚLTIMO día del mes EN CURSO (antes: día 1 → ayer).
 *   · Sólo comprobantes VIGENTES → los folios cancelados quedan verificados/excluidos.
 *   · La limpieza de XML del mes pasa a correr el DÍA 1 (ver src/scheduler/tasks.js).
 */
const fs     = require('fs');
const path   = require('path');
const AdmZip = require('adm-zip');
const satgo  = require('./satgo');
const { log } = require('../security/attackHandler');

// ── Periodo de descarga ─────────────────────────────────────────────────────────
// La CARPETA es siempre el mes EN CURSO (coincide con calcularIVA). El RANGO que se
// pide al SAT va del día 1 → AYER 23:59:59: el SAT rechaza con "Fecha final invalida"
// si la fecha final es hoy o futura (por eso NO se usa el último día del mes).
// Caso especial día 1: el mes en curso aún no tiene datos → baja TODO el mes anterior
// (pero se guarda/lee como mes en curso para que el dashboard no salga vacío).
function periodoMesActual() {
  // Reloj de México (el SAT opera en hora del centro): así "ayer" es un día YA cerrado
  // en México y la fecha final nunca cae en el futuro (evita "Fecha final invalida"
  // al anochecer, cuando el servidor UTC ya pasó a la fecha siguiente).
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const y    = now.getFullYear();
  const m    = now.getMonth();                      // 0-11
  const mm   = String(m + 1).padStart(2, '0');
  const ayer = new Date(y, m, now.getDate() - 1);
  const ayerY = ayer.getFullYear();
  const ayerM = String(ayer.getMonth() + 1).padStart(2, '0');
  const ayerD = String(ayer.getDate()).padStart(2, '0');

  let fi, ff;
  if (now.getDate() === 1) {
    fi = `${ayerY}-${ayerM}-01 00:00:00`;
    ff = `${ayerY}-${ayerM}-${ayerD} 23:59:59`;
  } else {
    fi = `${y}-${mm}-01 00:00:00`;
    ff = `${ayerY}-${ayerM}-${ayerD} 23:59:59`;
  }
  return { anio: y, mesNum: mm, fi, ff };
}

// ── Solicitar + verificar + descargar un tipo (emitidos/recibidos) por SatGo ────
// Retorna la cantidad de XMLs extraídos al disco.
async function descargarTipo(efirma, rfc, tipo, fi, ff, destDir, onProgreso) {
  const etiqueta = tipo === 'emitidos' ? 'emitidos' : 'recibidos';

  // PASO 1: Solicitar
  if (onProgreso) onProgreso(`Solicitando ${etiqueta} al SAT...`);
  log(`[SatGo] Solicitando ${tipo} RFC=${rfc} ${fi} → ${ff}`);
  const idSolicitud = await satgo.solicita(rfc, efirma, {
    tipo, fechaIni: fi, fechaFin: ff, estadoComprobante: 'Vigente',
  });
  log(`[SatGo] ${tipo}: IdSolicitud=${idSolicitud}`);

  // PASO 2: Verificar (polling) — hasta ~20 min (80 × 15s)
  let intentos = 0;
  const maxIntentos = 80;
  while (intentos < maxIntentos) {
    intentos++;
    if (onProgreso) onProgreso(`${etiqueta}: verificando (intento ${intentos})...`);
    const v = await satgo.verifica(rfc, efirma, idSolicitud);
    log(`[SatGo] verifica ${tipo}: estado=${v.estado} cod=${v.cod} paquetes=${v.paquetes.length}`);

    // Terminada
    if (v.estado === 3) {
      if (!v.paquetes.length) {
        log(`[SatGo] ${tipo}: 0 paquetes`);
        return 0;
      }
      // PASO 3: Descargar cada paquete y extraer XMLs
      if (onProgreso) onProgreso(`Descargando ${v.paquetes.length} paquete(s) de ${etiqueta}...`);
      fs.mkdirSync(destDir, { recursive: true });
      let totalXmls = 0;

      for (const idPaq of v.paquetes) {
        log(`[SatGo] Descargando paquete ${idPaq}...`);
        const b64 = await satgo.descarga(rfc, efirma, idPaq);
        if (!b64) { log(`[SatGo] paquete ${idPaq} vacío`); continue; }

        const zip = new AdmZip(Buffer.from(b64, 'base64'));
        for (const entry of zip.getEntries()) {
          if (entry.entryName.toLowerCase().endsWith('.xml')) {
            fs.writeFileSync(path.join(destDir, entry.entryName), entry.getData());
            totalXmls++;
          }
        }
        log(`[SatGo] Paquete ${idPaq}: ${totalXmls} XMLs acumulados en ${destDir}`);
      }
      return totalXmls;
    }

    // Rechazada / error / vencida
    if (v.estado >= 4) {
      throw new Error(
        `SAT rechazó ${etiqueta}: estado=${v.estado} cod=${v.cod}. ` +
        `${v.estado === 5 ? 'Posible límite diario excedido.' : ''} ${v.mensaje}`.trim()
      );
    }

    // En proceso (1 o 2) — esperar 15 s
    await new Promise(r => setTimeout(r, 15000));
  }

  throw new Error(`Timeout: el SAT tardó más de lo esperado en procesar ${etiqueta}.`);
}

// ── Punto de entrada: ejecutar descarga en background para un job ───────────────
async function ejecutarDescargaJob(jobId, { cerPath, keyPath, password, rfc, tempXmlPath }) {
  const { actualizarJob } = require('../jobs/manager');
  const { calcularIVA }   = require('./parser');
  const { loadEFirma }    = require('./auth');

  try {
    const efirma = { cerPath, keyPath, password };

    // Validar la e.firma (contraseña) localmente antes de ir al SAT: da un error
    // claro si la clave está mal, en vez de un rechazo opaco del servicio.
    try { loadEFirma(cerPath, keyPath, password); }
    catch (e) { throw new Error(`e.firma inválida: ${e.message}`); }

    // Periodo = mes en curso, día 1 → último del mes.
    const { anio, mesNum, fi, ff } = periodoMesActual();
    const base = path.join(tempXmlPath.replace(/\\/g, '/'), rfc, `${anio}${mesNum}`);

    log(`[Job ${jobId}] RFC=${rfc} periodo ${fi} → ${ff}`);
    actualizarJob(jobId, { estado: 'iniciando', progreso: `Conectando al SAT (${fi} a ${ff})...` });

    let emitidos = 0, recibidos = 0;
    const errores = [];

    // ── Emitidos ──────────────────────────────────────────────────────────────
    try {
      actualizarJob(jobId, { estado: 'procesando_e', progreso: 'SAT: solicitando emitidos...' });
      emitidos = await descargarTipo(
        efirma, rfc, 'emitidos', fi, ff,
        path.join(base, 'emitidos'),
        msg => actualizarJob(jobId, { progreso: msg })
      );
      actualizarJob(jobId, { emitidos });
      log(`[Job ${jobId}] Emitidos: ${emitidos} XMLs descargados`);
    } catch (e) {
      log(`[Job ${jobId}] Error E: ${e.message}`);
      errores.push({ tipo: 'E', mensaje: e.message });
      actualizarJob(jobId, { errores: [...errores] });
    }

    // ── Recibidos ─────────────────────────────────────────────────────────────
    try {
      actualizarJob(jobId, { estado: 'procesando_r', progreso: 'SAT: solicitando recibidos...' });
      recibidos = await descargarTipo(
        efirma, rfc, 'recibidos', fi, ff,
        path.join(base, 'recibidos'),
        msg => actualizarJob(jobId, { progreso: msg })
      );
      actualizarJob(jobId, { recibidos });
      log(`[Job ${jobId}] Recibidos: ${recibidos} XMLs descargados`);
    } catch (e) {
      log(`[Job ${jobId}] Error R: ${e.message}`);
      errores.push({ tipo: 'R', mensaje: e.message });
      actualizarJob(jobId, { errores: [...errores] });
    }

    // ── Clasificar y calcular IVA ─────────────────────────────────────────────
    actualizarJob(jobId, { estado: 'clasificando', progreso: 'Clasificando CFDIs y calculando IVA...' });
    const datos = calcularIVA(tempXmlPath, rfc);
    log(`[Job ${jobId}] Listo: emitidos=${datos.emitidos.length} recibidos=${datos.recibidos.length} IVA=${datos.resultado}`);

    actualizarJob(jobId, {
      estado:    'listo',
      progreso:  `Listo: ${datos.emitidos.length} emitidos, ${datos.recibidos.length} recibidos`,
      emitidos:  datos.emitidos.length,
      recibidos: datos.recibidos.length,
      errores,
      datos
    });

  } catch (e) {
    log(`[Job ${jobId}] Error fatal: ${e.message}`);
    actualizarJob(jobId, { estado: 'error', progreso: e.message });
  }
}

module.exports = { ejecutarDescargaJob };
