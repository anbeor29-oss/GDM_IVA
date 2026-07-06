'use strict';
const fs   = require('fs');
const path = require('path');
const {
  Fiel, FielRequestBuilder, Service, HttpsWebClient,
  ServiceEndpoints, QueryParameters, DateTimePeriod,
  DownloadType, RequestType, CfdiPackageReader
} = require('@nodecfdi/sat-ws-descarga-masiva');
const { log } = require('../security/attackHandler');

// Ã¢â€â‚¬Ã¢â€â‚¬ Crear servicio SAT con las credenciales del usuario Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function crearServicio(cerPath, keyPath, password) {
  const fiel = Fiel.create(
    fs.readFileSync(cerPath, 'binary'),
    fs.readFileSync(keyPath, 'binary'),
    password
  );

  if (!fiel.isValid()) {
    throw new Error('La e.firma (FIEL) no es vÃƒÂ¡lida o estÃƒÂ¡ vencida.');
  }

  const requestBuilder = new FielRequestBuilder(fiel);
  const webClient      = new HttpsWebClient();
  return new Service(requestBuilder, webClient, null, ServiceEndpoints.cfdi());
}

// â”€â”€ Wrapper defensivo para llamadas al SDK oficial â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// El SDK @nodecfdi puede lanzar errores con `webError.getResponse is not a function`
// cuando el SAT devuelve algo inesperado (timeout, error de red, formato raro).
// Este wrapper captura ese caso y reintenta con delay antes de rendirse.
async function llamarSATConReintento(nombreOp, fn, maxIntentos = 3) {
  let ultimoError = null;
  for (let i = 1; i <= maxIntentos; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;
      const msg = err && err.message ? err.message : String(err);
      log(`[SAT] Error en ${nombreOp} (intento ${i}/${maxIntentos}): ${msg}`);

      // Errores conocidos del SDK que valen la pena reintentar
      const esErrorSDK = msg.includes('getResponse is not a function') ||
                        msg.includes('ECONNRESET') ||
                        msg.includes('ETIMEDOUT') ||
                        msg.includes('socket hang up') ||
                        msg.includes('network') ||
                        msg.includes('timeout');

      if (!esErrorSDK || i === maxIntentos) {
        // No es error recuperable, o ya se agotaron reintentos
        break;
      }

      // Espera exponencial antes de reintentar: 5s, 10s, 20s...
      const delayMs = 5000 * Math.pow(2, i - 1);
      log(`[SAT] Reintentando en ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Traducir el error a algo Ãºtil para el usuario
  const msg = ultimoError && ultimoError.message ? ultimoError.message : String(ultimoError);
  if (msg.includes('getResponse is not a function')) {
    throw new Error(`El SAT no respondiÃ³ correctamente durante ${nombreOp}. Puede ser intermitencia del portal SAT o rango de fechas invÃ¡lido. Intenta de nuevo en unos minutos.`);
  }
  throw ultimoError;
}

// â”€â”€ Solicitar + verificar + descargar un tipo (E o R) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Retorna la cantidad de XMLs extraÃ­dos al disco.
async function descargarTipo(service, rfc, period, tipo, destDir, onProgreso) {
  const downloadType = new DownloadType(tipo === 'E' ? 'issued' : 'received');
  const requestType  = new RequestType('xml');

  // PASO 1: Solicitar descarga
  if (onProgreso) onProgreso(`Solicitando ${tipo === 'E' ? 'emitidos' : 'recibidos'} al SAT...`);
  log(`[SAT] Solicitando ${tipo} para RFC=${rfc}`);

  // Para R (recibidos) el SAT requiere DocumentStatus('active') o devuelve 301.
  // Para E (emitidos) funciona sin DocumentStatus.
  let queryParams = QueryParameters.create(period, downloadType, requestType);
  // Siempre solicitar solo vigentes (active) Ã¢â‚¬â€ evita el error 301 del SAT
  const { DocumentStatus } = require('@nodecfdi/sat-ws-descarga-masiva');
  queryParams = queryParams.withDocumentStatus(new DocumentStatus('active'));
  const queryResult = await llamarSATConReintento(
    `solicitar ${tipo}`,
    () => service.query(queryParams)
  );

  const statusCode = queryResult.getStatus().getCode();
  const requestId  = queryResult.getRequestId();
  const message    = queryResult.getStatus().getMessage();

  log(`[SAT] Solicitud ${tipo}: status=${statusCode} requestId=${requestId} msg=${message}`);

  if (statusCode !== 5000 || !requestId) {
    throw new Error(`SAT rechazÃƒÂ³ solicitud ${tipo}: cÃƒÂ³digo=${statusCode} mensaje=${message}`);
  }

  // PASO 2: Verificar hasta que estÃƒÂ© lista (polling)
  let intentos = 0;
  const maxIntentos = 50;  // ~25 minutos (50 Ãƒâ€” 30s)

  while (intentos < maxIntentos) {
    intentos++;
    if (onProgreso) onProgreso(`${tipo === 'E' ? 'Emitidos' : 'Recibidos'}: verificando (intento ${intentos})...`);

    const verifyResult = await llamarSATConReintento(
      `verificar ${tipo}`,
      () => service.verify(requestId)
    );
    const statusReq    = verifyResult.getStatusRequest().getValue();
    const codeStatus   = verifyResult.getCodeRequest().getValue();
    const packagesIds  = verifyResult.getPackageIds();
    const numCfdis     = verifyResult.getNumberCfdis();

    log(`[SAT] Verificar ${tipo}: statusReq=${statusReq} code=${codeStatus} CFDIs=${numCfdis} paquetes=${packagesIds.length}`);

    // Terminada
    if (statusReq === 3) {
      if (packagesIds.length === 0) {
        log(`[SAT] ${tipo}: 0 paquetes / ${numCfdis} CFDIs`);
        return 0;
      }

      // PASO 3: Descargar cada paquete y extraer XMLs
      if (onProgreso) onProgreso(`Descargando ${packagesIds.length} paquete(s) de ${tipo === 'E' ? 'emitidos' : 'recibidos'}...`);
      fs.mkdirSync(destDir, { recursive: true });
      let totalXmls = 0;

      for (const packageId of packagesIds) {
        log(`[SAT] Descargando paquete ${packageId}...`);
        const downloadResult = await llamarSATConReintento(
          `descargar paquete ${packageId}`,
          () => service.download(packageId)
        );

        if (downloadResult.getStatus().getCode() !== 5000) {
          log(`[SAT] Error descargando paquete ${packageId}: ${downloadResult.getStatus().getMessage()}`);
          continue;
        }

        // El paquete es un ZIP en base64; CfdiPackageReader lo maneja
        const packageContent = downloadResult.getPackageContent();
        const zipBuffer      = Buffer.from(packageContent, 'base64');
        const zipPath        = path.join(destDir, `${packageId}.zip`);
        fs.writeFileSync(zipPath, zipBuffer);

        // Extraer XMLs del ZIP
        const AdmZip  = require('adm-zip');
        const zip     = new AdmZip(zipBuffer);
        const entries = zip.getEntries();
        for (const entry of entries) {
          if (entry.entryName.toLowerCase().endsWith('.xml')) {
            fs.writeFileSync(path.join(destDir, entry.entryName), entry.getData());
            totalXmls++;
          }
        }

        // Limpiar ZIP temporal
        try { fs.unlinkSync(zipPath); } catch (_) {}
        log(`[SAT] Paquete ${packageId}: ${entries.length} archivos Ã¢â€ â€™ ${totalXmls} XMLs en ${destDir}`);
      }

      return totalXmls;
    }

    // Rechazada
    if (statusReq === 4 || statusReq === 5) {
      throw new Error(`SAT rechazÃƒÂ³ ${tipo}: statusReq=${statusReq} code=${codeStatus}. ${statusReq === 5 ? 'Posible lÃƒÂ­mite diario excedido.' : ''}`);
    }

    // En proceso (statusReq 1 o 2) Ã¢â‚¬â€ esperar 30 segundos
    await new Promise(r => setTimeout(r, 30000));
  }

  throw new Error(`Timeout: el SAT tardÃƒÂ³ mÃƒÂ¡s de 25 min en procesar ${tipo === 'E' ? 'emitidos' : 'recibidos'}.`);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Punto de entrada: ejecutar descarga en background para un job Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function ejecutarDescargaJob(jobId, { cerPath, keyPath, password, rfc, tempXmlPath }) {
  const { actualizarJob } = require('../jobs/manager');
  const { calcularIVA }   = require('./parser');

  try {
    // Calcular periodo:
    //  - MES: siempre el mes en curso (donde se guardan y consultan los CFDIs)
    //  - Rango de descarga: dÃƒÂ­a 1 del mes en curso Ã¢â€ â€™ ayer (SAT no acepta el dÃƒÂ­a en curso)
    //  - Caso especial dÃƒÂ­a 1: no hay datos aÃƒÂºn del mes en curso, descarga TODO el mes anterior
    const now   = new Date();
    const ayer  = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const nowY  = now.getFullYear();
    const nowM  = String(now.getMonth() + 1).padStart(2, '0');
    const ayerY = ayer.getFullYear();
    const ayerM = String(ayer.getMonth() + 1).padStart(2, '0');
    const ayerD = String(ayer.getDate()).padStart(2, '0');

    // Si estamos dÃƒÂ­a 1: descarga el mes anterior completo, guarda como mes actual
    //                   (para que se muestre en el dashboard del mes en curso)
    // Del dÃƒÂ­a 2 en adelante: descarga desde el dÃƒÂ­a 1 del mes hasta ayer
    let fi, ff;
    if (now.getDate() === 1) {
      fi = `${ayerY}-${ayerM}-01T00:00:00`;
      ff = `${ayerY}-${ayerM}-${ayerD}T23:59:59`;
    } else {
      fi = `${nowY}-${nowM}-01T00:00:00`;
      ff = `${ayerY}-${ayerM}-${ayerD}T23:59:59`;
    }

    // La carpeta destino es SIEMPRE la del mes en curso (coincide con calcularIVA)
    const base  = path.join(tempXmlPath.replace(/\\/g, '/'), rfc, `${nowY}${nowM}`);

    log(`[Job ${jobId}] RFC=${rfc} periodo ${fi} Ã¢â€ â€™ ${ff}`);
    actualizarJob(jobId, { estado: 'iniciando', progreso: `Conectando al SAT (${fi} a ${ff})...` });

    // Crear servicio con el paquete oficial @nodecfdi
    const service = crearServicio(cerPath, keyPath, password);
    const period  = DateTimePeriod.createFromValues(fi, ff);

    let emitidos = 0, recibidos = 0;
    const errores = [];

    // Ã¢â€â‚¬Ã¢â€â‚¬ Emitidos Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    try {
      actualizarJob(jobId, { estado: 'procesando_e', progreso: 'SAT: solicitando emitidos...' });
      emitidos = await descargarTipo(
        service, rfc, period, 'E',
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

    // Ã¢â€â‚¬Ã¢â€â‚¬ Recibidos Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    try {
      actualizarJob(jobId, { estado: 'procesando_r', progreso: 'SAT: solicitando recibidos...' });
      recibidos = await descargarTipo(
        service, rfc, period, 'R',
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

    // Ã¢â€â‚¬Ã¢â€â‚¬ Clasificar y calcular IVA Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

module.exports = { ejecutarDescargaJob, crearServicio };
