'use strict';
const express = require('express');
const path    = require('path');
const router  = express.Router();

const { ejecutarDescargaJob, periodoMesActual } = require('../sat/download');
const satgo                   = require('../sat/satgo');
const { calcularIVA }         = require('../sat/parser');
const { crearJob, obtenerJob }= require('../jobs/manager');
const { satLimiter }          = require('../security/rateLimiter');
const { log }                 = require('../security/attackHandler');
const { getUsuarioById, estadoAcceso, consumir, saldoCreditos, registrarUso } = require('../db/database');

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
    creditosRestantes: acc.creditosRestantes != null ? acc.creditosRestantes : (u ? saldoCreditos(u.id) : 0),
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

  // Cobro de la consulta según la vía (cliente/activo = gratis; prueba = baja 1;
  // créditos = −1) y registro en la bitácora. Una consulta = una descarga de un mes.
  const now = new Date();
  const periodo = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const cobro = consumir(u.id, 'CONSULTA', { rfc, periodo });
  let prueba = null;
  if (cobro.via === 'prueba') {
    prueba = { restantes: cobro.restantes, bloqueado: (cobro.restantes || 0) <= 0 };
    req.session.estado = prueba.bloqueado ? 'BLOQUEADO' : 'PRUEBA';
  }

  // Lanzar descarga en background — NO esperamos aquí
  ejecutarDescargaJob(job.id, {
    cerPath, keyPath, password: efirmaPassword, rfc, tempXmlPath: TEMP_XML_PATH
  }).catch(e => log(`[Job ${job.id}] Excepción no capturada: ${e.message}`));

  // Responder inmediatamente con el jobId (+ estado de prueba / créditos)
  res.json({ ok: true, jobId: job.id, estado: 'iniciando', prueba, cobro });
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
    const buf = construirXlsx(hojasDeIVA(d, rfc, periodo));
    registrarUso(req.session.userId, { rfc, periodo, tipo: 'EXPORT', via: acc.motivo, resultado: 'OK' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="IVA_${rfc}_${periodo}.xlsx"`);
    res.send(buf);
  } catch (e) {
    log(`exportar error: ${e.message}`);
    res.status(500).send('No se pudo generar el Excel: ' + e.message);
  }
});

// ── Armado del .xlsx (sin dependencias nuevas: usa adm-zip, un .xlsx es un ZIP) ─
// Tres hojas: «IVA cobrado» (emitidos), «IVA acreditable» (recibidos) y «Resumen».
function hojasDeIVA(d, rfc, periodo) {
  const enc = ['Tipo', 'Fecha', 'Serie', 'Folio', 'RFC Emisor', 'Nombre Emisor',
               'RFC Receptor', 'Nombre Receptor', 'Subtotal/Base', 'IVA', 'Total', 'Moneda', 'UUID'];
  const fila = (c) => [c.etiquetaTipo, c.fecha, c.serie, c.folio, c.rfcEmisor, c.nombreEmisor,
                       c.rfcReceptor, c.nombreReceptor, c.subtotal, c.iva, c.total, c.moneda, c.uuid];
  const hoja = (titulo, lista, totalIva) => {
    const rows = [[`${titulo} del periodo ${periodo} · RFC ${rfc}`], [], enc];
    (lista || []).forEach((c) => rows.push(fila(c)));
    rows.push([]);
    rows.push(['TOTAL ' + titulo.toUpperCase(), '', '', '', '', '', '', '', '', totalIva]);
    return rows;
  };
  return [
    { nombre: 'IVA cobrado', rows: hoja('IVA cobrado', d.emitidos, d.ivaTraslado) },
    { nombre: 'IVA acreditable', rows: hoja('IVA acreditable', d.recibidos, d.ivaAcreditable) },
    { nombre: 'Resumen', rows: [
      [`Resumen de IVA del periodo ${periodo} · RFC ${rfc}`], [],
      ['IVA Trasladado (cobrado)', d.ivaTraslado],
      ['IVA Acreditable (pagado)', d.ivaAcreditable],
      [d.aCargo ? 'IVA a cargo' : 'IVA a favor', Math.round(Math.abs(d.resultado) * 100) / 100],
    ] },
  ];
}

function colLetter(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function escXml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function celdaXml(colIdx, rowNum, val) {
  if (val == null || val === '') return '';
  const ref = colLetter(colIdx) + rowNum;
  if (typeof val === 'number' && isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
}
function construirXlsx(hojas) {
  const AdmZip = require('adm-zip');
  const P = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const sheetXml = (rows) => {
    let sheetData = '';
    rows.forEach((row, ri) => {
      const r = ri + 1;
      sheetData += `<row r="${r}">${row.map((v, ci) => celdaXml(ci, r, v)).join('')}</row>`;
    });
    return `${P}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
  };
  const n = hojas.map((_, i) => i + 1);
  const ct = `${P}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${n.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rels = `${P}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wb = `${P}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${hojas.map((h, i) => `<sheet name="${escXml(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const wbRels = `${P}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${n.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}</Relationships>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(ct, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(rels, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(wb, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(wbRels, 'utf8'));
  hojas.forEach((h, i) => zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(h.rows), 'utf8')));
  return zip.toBuffer();
}

// ── Info de sesión ────────────────────────────────────────────────────────────
router.get('/api/sesion', requireAuth, (req, res) => {
  // "Día" = AYER en hora de México (el periodo de consulta llega hasta ayer).
  const mx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const ayer = new Date(mx.getTime() - 24 * 60 * 60 * 1000);
  res.json({
    nombre: req.session.nombre,
    rfc:    req.session.rfc,
    dia:    ayer.getDate()
  });
});

// ── Diagnóstico facfiel: ver QUÉ devuelve SatGo (sin escribir nada a disco) ─────
// Uso: /dashboard/api/debug-facfiel?tipo=emitidos|recibidos . Devuelve success,
// count, requestId, nComprobantes y las llaves del primer comprobante.
router.get('/api/debug-facfiel', requireAuth, async (req, res) => {
  try {
    const { rfc, cerPath, keyPath, efirmaPassword } = req.session;
    if (!cerPath || !keyPath || !efirmaPassword) return res.status(400).json({ error: 'Sin e.firma en sesión. Entra al dashboard primero.' });
    const tipo = req.query.tipo === 'recibidos' ? 'recibidos' : 'emitidos';
    const per = periodoMesActual();
    // Permite probar rangos a mano: ?fi=2026-10-01 00:00:00&ff=2026-10-11 23:59:59
    const fi = req.query.fi ? String(req.query.fi) : per.fi;
    const ff = req.query.ff ? String(req.query.ff) : per.ff;
    const estatus = req.query.estatus;   // -1 Todos, 0 Cancelados, 1 Vigentes (default 1)
    const out = await satgo.consultaFacDebug(rfc, { cerPath, keyPath, password: efirmaPassword }, { tipo, fechaIni: fi, fechaFin: ff, estatus });
    res.json({ rfc, tipo, periodo: { fi, ff }, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
