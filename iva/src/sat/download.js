'use strict';
const fs   = require('fs');
const path = require('path');
const {
  Fiel, FielRequestBuilder, Service, HttpsWebClient,
  ServiceEndpoints, QueryParameters, DateTimePeriod,
  DownloadType, RequestType, CfdiPackageReader
} = require('@nodecfdi/sat-ws-descarga-masiva');
const { log } = require('../security/attackHandler');

// ── Crear servicio SAT con las credenciales del usuario ──────────────────────
function crearServicio(cerPath, keyPath, password) {
  const fiel = Fiel.create(
    fs.readFileSync(cerPath, 'binary'),
    fs.readFileSync(keyPath, 'binary'),
    password
  );

  if (!fiel.isValid()) {
    throw new Error('La e.firma (FIEL) no es válida o está vencida.');
  }

  const requestBuilder = new FielRequestBuilder(fiel);
  const webClient      = new HttpsWebClient();
  return new Service(requestBuilder, webClient, null, ServiceEndpoints.cfdi());
}

// ── Solicitar + verificar + descargar un tipo (E o R) ────────────────────────
// Retorna la cantidad de XMLs extraídos al disco.
async function descargarTipo(service, rfc, period, tipo, destDir, onProgreso) {
  const downloadType = new DownloadType(tipo === 'E' ? 'issued' : 'received');
  const requestType  = new RequestType('xml');

  // PASO 1: Solicitar descarga
  if (onProgreso) onProgreso(`Solicitando ${tipo === 'E' ? 'emitidos' : 'recibidos'} al SAT...`);
  log(`[SAT] Solicitando ${tipo} para RFC=${rfc}`);

  // Para R (recibidos) el SAT requiere DocumentStatus('active') o devuelve 301.
  // Para E (emitidos) funciona sin DocumentStatus.
  let queryParams = QueryParameters.create(period, downloadType, requestType);
  // Siempre solicitar solo vigentes (active) — evita el error 301 del SAT
  const { DocumentStatus } = require('@nodecfdi/sat-ws-descarga-masiva');
  queryParams = queryParams.withDocumentStatus(new DocumentStatus('active'));
  const queryResult = await service.query(queryParams);

  const statusCode = queryResult.getStatus().getCode();
  const requestId  = queryResult.getRequestId();
  const message    = queryResult.getStatus().getMessage();

  log(`[SAT] Solicitud ${tipo}: status=${statusCode} requestId=${requestId} msg=${message}`);

  if (statusCode !== 5000 || !requestId) {
    throw new Error(`SAT rechazó solicitud ${tipo}: código=${statusCode} mensaje=${message}`);
  }

  // PASO 2: Verificar hasta que esté lista (polling)
  let intentos = 0;
  const maxIntentos = 50;  // ~25 minutos (50 × 30s)

  while (intentos < maxIntentos) {
    intentos++;
    if (onProgreso) onProgreso(`${tipo === 'E' ? 'Emitidos' : 'Recibidos'}: verificando (intento ${intentos})...`);

    const verifyResult = await service.verify(requestId);
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
        const downloadResult = await service.download(packageId);

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
        log(`[SAT] Paquete ${packageId}: ${entries.length} archivos → ${totalXmls} XMLs en ${destDir}`);
      }

      return totalXmls;
    }

    // Rechazada
    if (statusReq === 4 || statusReq === 5) {
      throw new Error(`SAT rechazó ${tipo}: statusReq=${statusReq} code=${codeStatus}. ${statusReq === 5 ? 'Posible límite diario excedido.' : ''}`);
    }

    // En proceso (statusReq 1 o 2) — esperar 30 segundos
    await new Promise(r => setTimeout(r, 30000));
  }

  throw new Error(`Timeout: el SAT tardó más de 25 min en procesar ${tipo === 'E' ? 'emitidos' : 'recibidos'}.`);
}

// ── Punto de entrada: ejecutar descarga en background para un job ─────────────
async function ejecutarDescargaJob(jobId, { cerPath, keyPath, password, rfc, tempXmlPath }) {
  const { actualizarJob } = require('../jobs/manager');
  const { calcularIVA }   = require('./parser');

  try {
    // Calcular periodo: del día 1 del mes hasta ayer
    const now   = new Date();
    const ayer  = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const ayerY = ayer.getFullYear();
    const ayerM = String(ayer.getMonth() + 1).padStart(2, '0');
    const ayerD = String(ayer.getDate()).padStart(2, '0');
    const fi    = `${ayerY}-${ayerM}-01T00:00:00`;
    const ff    = `${ayerY}-${ayerM}-${ayerD}T23:59:59`;
    const base  = path.join(tempXmlPath.replace(/\\/g, '/'), rfc, `${ayerY}${ayerM}`);

    log(`[Job ${jobId}] RFC=${rfc} periodo ${fi} → ${ff}`);
    actualizarJob(jobId, { estado: 'iniciando', progreso: `Conectando al SAT (${fi} a ${ff})...` });

    // Crear servicio con el paquete oficial @nodecfdi
    const service = crearServicio(cerPath, keyPath, password);
    const period  = DateTimePeriod.createFromValues(fi, ff);

    let emitidos = 0, recibidos = 0;
    const errores = [];

    // ── Emitidos ──────────────────────────────────────────────────────────────
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

    // ── Recibidos ─────────────────────────────────────────────────────────────
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

module.exports = { ejecutarDescargaJob, crearServicio };
