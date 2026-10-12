'use strict';
/**
 * Motor de descarga de CFDI por SatGo — consulta SÍNCRONA (Consultar/facfiel).
 *
 * UNA sola llamada por tipo con la e.firma del usuario (FIEL): el SAT devuelve los
 * comprobantes con su XML en base64 (campo `content`), en segundos, en vez del flujo
 * asíncrono solicita → verifica → descarga (que para "recibidos" tardaba decenas de
 * minutos). Mismo periodo (día 1 → ayer, hora de México), mismo parser y cálculo.
 *
 * Nota: para clientes con MUCHO volumen una consulta síncrona podría venir topada;
 * en ese caso el SAT suele devolver sólo un `requestId` (modo metadata) y convendría
 * caer al flujo asíncrono — ver satgo.solicita/verifica/descarga (siguen disponibles).
 */
const fs     = require('fs');
const path   = require('path');
const satgo  = require('./satgo');
const { log } = require('../security/attackHandler');

// ── Periodo de descarga ─────────────────────────────────────────────────────────
// MES EN CURSO completo: del día 1 00:00:00 → AHORA (hora de México). "Hasta ahora"
// incluye el día en curso y nunca es fecha futura. En facfiel (consulta síncrona) el
// SAT devuelve lo que exista del periodo. La carpeta es el mes en curso (coincide con
// calcularIVA); la limpieza del mes anterior la hace el scheduler el día 1.
function periodoMesActual() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const y   = now.getFullYear();
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const p   = n => String(n).padStart(2, '0');
  const fi  = `${y}-${mm}-01 00:00:00`;
  const ff  = `${y}-${mm}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  return { anio: y, mesNum: mm, fi, ff };
}

// ── Guarda a disco los XML (base64) que devolvió facfiel ────────────────────────
// Cada consulta es un SNAPSHOT completo del periodo, así que limpiamos la carpeta
// antes de escribir (para no dejar XML viejos, p. ej. de comprobantes cancelados).
// Devuelve cuántos XML escribió.
function guardarComprobantes(comprobantes, destDir) {
  try {
    if (fs.existsSync(destDir)) {
      for (const f of fs.readdirSync(destDir)) {
        if (f.toLowerCase().endsWith('.xml')) { try { fs.unlinkSync(path.join(destDir, f)); } catch (_) {} }
      }
    }
  } catch (_) {}
  fs.mkdirSync(destDir, { recursive: true });
  if (!comprobantes || !comprobantes.length) return 0;

  let n = 0;
  for (const c of comprobantes) {
    // Excluir cancelados por si el SAT no los filtró.
    const estado = String(c.estadoDeComprobante || c.EstadoDeComprobante || '').toLowerCase();
    if (estado.includes('cancel')) continue;
    const b64 = c.content || c.Content;
    if (!b64) continue;
    const uuid = c.uuid || c.Uuid || c.UUID || `cfdi_${Date.now()}_${n}`;
    try {
      fs.writeFileSync(path.join(destDir, `${uuid}.xml`), Buffer.from(b64, 'base64'));
      n++;
    } catch (_) {}
  }
  return n;
}

// ── Consulta síncrona de un tipo (emitidos/recibidos) y guarda los XML ──────────
async function descargarTipo(efirma, rfc, tipo, fi, ff, destDir, onProgreso) {
  if (onProgreso) onProgreso(`Consultando ${tipo} al SAT...`);
  log(`[SatGo] facfiel ${tipo} RFC=${rfc} ${fi} → ${ff}`);
  const r = await satgo.consultaFac(rfc, efirma, { tipo, fechaIni: fi, fechaFin: ff });
  if ((!r.comprobantes || !r.comprobantes.length) && r.requestId) {
    // El SAT devolvió un requestId en vez de los comprobantes (posible alto volumen).
    log(`[SatGo] ${tipo}: el SAT devolvió requestId=${r.requestId} sin comprobantes síncronos`);
  }
  const n = guardarComprobantes(r.comprobantes, destDir);
  log(`[SatGo] ${tipo}: ${n} XMLs guardados en ${destDir} (count SAT=${r.count})`);
  return n;
}

// ── Punto de entrada: ejecutar la consulta en background para un job ────────────
async function ejecutarDescargaJob(jobId, { cerPath, keyPath, password, rfc, tempXmlPath }) {
  const { actualizarJob } = require('../jobs/manager');
  const { calcularIVA }   = require('./parser');
  const { loadEFirma }    = require('./auth');

  try {
    const efirma = { cerPath, keyPath, password };

    // Validar la e.firma (contraseña) localmente antes de ir al SAT.
    try { loadEFirma(cerPath, keyPath, password); }
    catch (e) { throw new Error(`e.firma inválida: ${e.message}`); }

    const { anio, mesNum, fi, ff } = periodoMesActual();
    const base = path.join(tempXmlPath.replace(/\\/g, '/'), rfc, `${anio}${mesNum}`);

    log(`[Job ${jobId}] RFC=${rfc} periodo ${fi} → ${ff} (facfiel síncrono)`);
    actualizarJob(jobId, { estado: 'procesando', progreso: `Consultando al SAT (${fi} a ${ff})...` });

    const errores = [];

    // Emitidos y recibidos EN PARALELO (cada uno es una sola llamada rápida).
    const [rE, rR] = await Promise.allSettled([
      descargarTipo(efirma, rfc, 'emitidos',  fi, ff, path.join(base, 'emitidos'),  m => actualizarJob(jobId, { progreso: m })),
      descargarTipo(efirma, rfc, 'recibidos', fi, ff, path.join(base, 'recibidos'), m => actualizarJob(jobId, { progreso: m })),
    ]);

    if (rE.status === 'fulfilled') {
      actualizarJob(jobId, { emitidos: rE.value });
      log(`[Job ${jobId}] Emitidos: ${rE.value} XMLs`);
    } else {
      const msg = (rE.reason && rE.reason.message) || String(rE.reason);
      log(`[Job ${jobId}] Error E: ${msg}`);
      errores.push({ tipo: 'E', mensaje: msg });
    }

    if (rR.status === 'fulfilled') {
      actualizarJob(jobId, { recibidos: rR.value });
      log(`[Job ${jobId}] Recibidos: ${rR.value} XMLs`);
    } else {
      const msg = (rR.reason && rR.reason.message) || String(rR.reason);
      log(`[Job ${jobId}] Error R: ${msg}`);
      errores.push({ tipo: 'R', mensaje: msg });
    }

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

module.exports = { ejecutarDescargaJob, periodoMesActual };
