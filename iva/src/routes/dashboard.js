'use strict';
const express = require('express');
const path    = require('path');
const router  = express.Router();

const { ejecutarDescargaJob } = require('../sat/download');
const { calcularIVA }         = require('../sat/parser');
const { crearJob, obtenerJob }= require('../jobs/manager');
const { satLimiter }          = require('../security/rateLimiter');
const { log }                 = require('../security/attackHandler');
const { getUsuarioById, estadoAcceso, registrarConsultaPrueba } = require('../db/database');

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
  return dia >= 3 && dia <= 29;
}

// ── Página del dashboard ──────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  if (!dentroDeVentana()) return res.redirect('/login?error=ventana');
  // Gating de comercialización: cambio de pass → e.firma → bloqueo.
  const u = getUsuarioById(req.session.userId);
  if (!u) return res.redirect('/login');
  if (u.must_change_password) return res.redirect('/cambiar-password');
  const acc = estadoAcceso(u);
  if (!acc.puede) return res.redirect('/bloqueado');
  if (!req.session.cerPath) return res.redirect('/configurar-efirma');
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'dashboard.html'));
});

// Estado de la cuenta (para que el dashboard muestre "te quedan N consultas" / "N días").
router.get('/api/estado-cuenta', requireAuth, (req, res) => {
  const u = getUsuarioById(req.session.userId);
  const acc = estadoAcceso(u);
  res.json({
    origen: u ? u.origen : null,
    estado: u ? u.estado : null,
    puede: acc.puede, motivo: acc.motivo,
    pruebasRestantes: acc.pruebasRestantes != null ? acc.pruebasRestantes : null,
    diasRestantes: acc.diasRestantes != null ? acc.diasRestantes : null,
    excel: !!(u && u.excel_habilitado),
  });
});

// ── PASO 1: Iniciar descarga en background (retorna inmediatamente) ────────────
// El cliente recibe un jobId y hace polling con /api/estado-descarga/:jobId
router.post('/api/iniciar-descarga', requireAuth, satLimiter, (req, res) => {
  if (!dentroDeVentana()) {
    return res.status(403).json({ error: 'Fuera de ventana de consulta (días 3-29)' });
  }

  // Gating: ¿puede consultar? (prueba agotada / bloqueado / vencido)
  const u = getUsuarioById(req.session.userId);
  const acc = estadoAcceso(u);
  if (!acc.puede) {
    return res.status(403).json({ error: 'Tu acceso está bloqueado.', motivo: acc.motivo, bloqueado: true });
  }

  const { rfc, cerPath, keyPath, efirmaPassword } = req.session;

  if (!cerPath || !keyPath || !efirmaPassword) {
    return res.status(400).json({ error: 'Faltan credenciales de e-firma en la sesión.', configurar: true });
  }

  const job = crearJob(rfc);
  log(`[Job ${job.id}] Iniciado por usuario ${req.session.nombre} RFC=${rfc}`);

  // Si es una cuenta en PRUEBA, esta consulta cuenta (y puede dejarla en 0 → bloqueo).
  let prueba = null;
  if (u && u.origen === 'AUTOREGISTRO' && u.estado === 'PRUEBA') {
    prueba = registrarConsultaPrueba(u.id);
    req.session.estado = prueba.bloqueado ? 'BLOQUEADO' : 'PRUEBA';
  }

  // Lanzar descarga en background — NO esperamos aquí
  ejecutarDescargaJob(job.id, {
    cerPath, keyPath, password: efirmaPassword, rfc, tempXmlPath: TEMP_XML_PATH
  }).catch(e => log(`[Job ${job.id}] Excepción no capturada: ${e.message}`));

  // Responder inmediatamente con el jobId (+ estado de prueba si aplica)
  res.json({ ok: true, jobId: job.id, estado: 'iniciando', prueba });
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
    return res.status(403).json({ error: 'Fuera de ventana de consulta (días 3-29)' });
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

// ── Exportar a Excel (.xlsx) el IVA del mes en curso ──────────────────────────
router.get('/exportar', requireAuth, (req, res) => {
  if (!dentroDeVentana()) return res.status(403).send('Fuera de ventana de consulta (días 3-29).');
  const u = getUsuarioById(req.session.userId);
  const acc = estadoAcceso(u);
  if (!acc.puede) return res.status(403).send('Tu acceso está bloqueado.');
  // La descarga a Excel es un extra de pago: clientes GDM y prospectos solo la tienen
  // si el admin se las habilitó (o si pagaron la anualidad, que ya la incluye).
  if (!u || !u.excel_habilitado) {
    return res.status(403).send('La descarga a Excel no está habilitada en tu cuenta. Es un servicio adicional; contáctanos para activarla.');
  }
  try {
    const rfc = req.session.rfc;
    const tp = process.env.TEMP_XML_PATH || 'C:/temp2xml';
    const d = calcularIVA(tp, rfc);
    const now = new Date();
    const periodo = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const buf = construirXlsx(filasDeIVA(d, rfc, periodo));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="IVA_${rfc}_${periodo}.xlsx"`);
    res.send(buf);
  } catch (e) {
    log(`exportar error: ${e.message}`);
    res.status(500).send('No se pudo generar el Excel: ' + e.message);
  }
});

// ── Armado del .xlsx (sin dependencias nuevas: usa adm-zip, un .xlsx es un ZIP) ─
function filasDeIVA(d, rfc, periodo) {
  const rows = [];
  rows.push([`IVA del periodo ${periodo} · RFC ${rfc}`]);
  rows.push([]);
  rows.push(['Clasificación', 'Tipo', 'Fecha', 'Serie', 'Folio', 'RFC Emisor', 'Nombre Emisor',
             'RFC Receptor', 'Nombre Receptor', 'Subtotal/Base', 'IVA', 'Total', 'Moneda', 'UUID']);
  const fila = (c, clas) => [clas, c.etiquetaTipo, c.fecha, c.serie, c.folio, c.rfcEmisor, c.nombreEmisor,
                             c.rfcReceptor, c.nombreReceptor, c.subtotal, c.iva, c.total, c.moneda, c.uuid];
  (d.emitidos || []).forEach((c) => rows.push(fila(c, 'EMITIDO (cobrado)')));
  (d.recibidos || []).forEach((c) => rows.push(fila(c, 'RECIBIDO (pagado)')));
  rows.push([]);
  rows.push(['RESUMEN']);
  rows.push(['IVA Trasladado (cobrado)', d.ivaTraslado]);
  rows.push(['IVA Acreditable (pagado)', d.ivaAcreditable]);
  rows.push([d.aCargo ? 'IVA a cargo' : 'IVA a favor', Math.round(Math.abs(d.resultado) * 100) / 100]);
  return rows;
}

function colLetter(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function escXml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function celdaXml(colIdx, rowNum, val) {
  if (val == null || val === '') return '';
  const ref = colLetter(colIdx) + rowNum;
  if (typeof val === 'number' && isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
}
function construirXlsx(rows) {
  const AdmZip = require('adm-zip');
  let sheetData = '';
  rows.forEach((row, ri) => {
    const r = ri + 1;
    sheetData += `<row r="${r}">${row.map((v, ci) => celdaXml(ci, r, v)).join('')}</row>`;
  });
  const P = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const sheet = `${P}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
  const ct = `${P}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `${P}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wb = `${P}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="IVA" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `${P}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(ct, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(rels, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(wb, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(wbRels, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  return zip.toBuffer();
}

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
