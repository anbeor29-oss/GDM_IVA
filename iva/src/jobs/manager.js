'use strict';
const crypto = require('crypto');

// ── Job store en memoria ──────────────────────────────────────────────────────
// Map de jobId → estado del job de descarga
// No necesita persistencia: si el servidor reinicia, el cliente detecta que
// el jobId ya no existe y muestra el botón de nuevo.
const jobs = new Map();

/**
 * Estados posibles:
 *   iniciando      → solicitud enviada al SAT, esperando IdSolicitud
 *   procesando_e   → SAT procesando emitidos (polling)
 *   procesando_r   → SAT procesando recibidos (polling)
 *   descargando    → descargando ZIP del SAT
 *   clasificando   → extrayendo y clasificando XMLs
 *   listo          → todo terminado
 *   error          → fallo no recuperable
 */
function crearJob(rfc) {
  const jobId = crypto.randomUUID();
  const job = {
    id:        jobId,
    rfc,
    estado:    'iniciando',
    progreso:  'Conectando con el SAT...',
    emitidos:  0,
    recibidos: 0,
    errores:   [],
    inicio:    Date.now(),
    datos:     null   // resultado de calcularIVA cuando esté listo
  };
  jobs.set(jobId, job);

  // Limpiar el job 2 horas después de creado
  setTimeout(() => jobs.delete(jobId), 2 * 60 * 60 * 1000);
  return job;
}

function obtenerJob(jobId) {
  return jobs.get(jobId) || null;
}

function actualizarJob(jobId, cambios) {
  const job = jobs.get(jobId);
  if (job) Object.assign(job, cambios);
  return job;
}

module.exports = { crearJob, obtenerJob, actualizarJob };
