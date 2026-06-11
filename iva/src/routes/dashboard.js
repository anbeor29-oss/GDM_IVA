'use strict';
const express = require('express');
const path    = require('path');
const router  = express.Router();

const { ejecutarDescargaJob } = require('../sat/download');
const { calcularIVA }         = require('../sat/parser');
const { crearJob, obtenerJob }= require('../jobs/manager');
const { satLimiter }          = require('../security/rateLimiter');
const { log }                 = require('../security/attackHandler');

const TEMP_XML_PATH = (process.env.TEMP_XML_PATH || 'C:/temp2xml').replace(/\\/g, '/');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

// MODO PRUEBA: sin restricción de fechas — cambiar a true en producción
const MODO_PRODUCCION = false;
function dentroDeVentana() {
  if (!MODO_PRODUCCION) return true;
  const dia = new Date().getDate();
  return dia >= 10 && dia <= 29;
}

// ── Página del dashboard ──────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  if (!dentroDeVentana()) return res.redirect('/login?error=ventana');
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'dashboard.html'));
});

// ── PASO 1: Iniciar descarga en background (retorna inmediatamente) ────────────
// El cliente recibe un jobId y hace polling con /api/estado-descarga/:jobId
router.post('/api/iniciar-descarga', requireAuth, satLimiter, (req, res) => {
  if (!dentroDeVentana()) {
    return res.status(403).json({ error: 'Fuera de ventana de consulta (días 10-29)' });
  }

  const { rfc, cerPath, keyPath, efirmaPassword } = req.session;

  if (!cerPath || !keyPath || !efirmaPassword) {
    return res.status(400).json({ error: 'Faltan credenciales de e-firma en la sesión.' });
  }

  const job = crearJob(rfc);
  log(`[Job ${job.id}] Iniciado por usuario ${req.session.nombre} RFC=${rfc}`);

  // Lanzar descarga en background — NO esperamos aquí
  ejecutarDescargaJob(job.id, {
    cerPath, keyPath, password: efirmaPassword, rfc, tempXmlPath: TEMP_XML_PATH
  }).catch(e => log(`[Job ${job.id}] Excepción no capturada: ${e.message}`));

  // Responder inmediatamente con el jobId
  res.json({ ok: true, jobId: job.id, estado: 'iniciando' });
});

// ── PASO 2: Consultar estado del job (polling del cliente cada 10s) ───────────
router.get('/api/estado-descarga/:jobId', requireAuth, (req, res) => {
  const job = obtenerJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado o expirado.' });

  // No enviar los datos completos de CFDIs en cada poll — solo cuando esté listo
  const { datos, ...jobSinDatos } = job;
  if (job.estado === 'listo') {
    res.json({ ...jobSinDatos, datos });
  } else {
    res.json(jobSinDatos);
  }
});

// ── Leer XMLs ya descargados en disco (sin ir al SAT) ─────────────────────────
router.get('/api/datos', requireAuth, (req, res) => {
  if (!dentroDeVentana()) {
    return res.status(403).json({ error: 'Fuera de ventana de consulta (días 10-29)' });
  }
  try {
    const rfc  = req.session.rfc;
    const tp   = process.env.TEMP_XML_PATH || 'C:/temp2xml';
    log(`api/datos: RFC=${rfc} PATH=${tp}`);
    const datos = calcularIVA(tp, rfc);
    log(`api/datos: emitidos=${datos.emitidos.length} recibidos=${datos.recibidos.length}`);
    res.json({ ok: true, ...datos });
  } catch (e) {
    log(`api/datos error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Info de sesión ────────────────────────────────────────────────────────────
router.get('/api/sesion', requireAuth, (req, res) => {
  res.json({
    nombre: req.session.nombre,
    rfc:    req.session.rfc,
    dia:    new Date().getDate()
  });
});

// ── Diagnóstico ───────────────────────────────────────────────────────────────
router.get('/api/debug', requireAuth, (req, res) => {
  const fs  = require('fs');
  const tp  = process.env.TEMP_XML_PATH || 'C:/temp2xml';
  const rfc = req.session.rfc;
  const now = new Date();
  const ayer = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const mes  = `${ayer.getFullYear()}${String(ayer.getMonth() + 1).padStart(2, '0')}`;
  const dirE = path.join(tp, rfc || 'SIN_RFC', mes, 'emitidos');
  const dirR = path.join(tp, rfc || 'SIN_RFC', mes, 'recibidos');
  res.json({
    TEMP_XML_PATH: tp, rfc, mes,
    emitidos:  { dir: dirE, existe: fs.existsSync(dirE), archivos: fs.existsSync(dirE) ? fs.readdirSync(dirE).length : 0 },
    recibidos: { dir: dirR, existe: fs.existsSync(dirR), archivos: fs.existsSync(dirR) ? fs.readdirSync(dirR).length : 0 },
    session: { userId: req.session.userId, nombre: req.session.nombre }
  });
});

module.exports = router;
