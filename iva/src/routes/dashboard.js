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
// La ventana de consulta (día 2 → último del mes) vive en un solo lugar.
const { dentroDeVentana, TEXTO_VENTANA } = require('../ventana');

const TEMP_XML_PATH = (process.env.TEMP_XML_PATH || 'C:/temp2xml').replace(/\\/g, '/');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
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
    return res.status(403).json({ error: 'Fuera de ventana de consulta (' + TEXTO_VENTANA + ')' });
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
    return res.status(403).json({ error: 'Fuera de ventana de consulta (' + TEXTO_VENTANA + ')' });
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
router.get('/exportar', requireAuth, async (req, res) => {
  if (!dentroDeVentana()) return res.status(403).send('Fuera de ventana de consulta (' + TEXTO_VENTANA + ').');
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
    const buf = await construirXlsx(d, rfc, periodo);
    registrarUso(req.session.userId, { rfc, periodo, tipo: 'EXPORT', via: acc.motivo, resultado: 'OK' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="IVA_${rfc}_${periodo}.xlsx"`);
    res.send(buf);
  } catch (e) {
    log(`exportar error: ${e.message}`);
    res.status(500).send('No se pudo generar el Excel: ' + e.message);
  }
});

// ── Armado del .xlsx con ExcelJS: el FORMATO DE LA CASA (el mismo que definió el
//    usuario en su hoja) + el pie de marca BLOQUEADO en «Resumen» ───────────────
//
// FORMATO (medido de la hoja que mandó el usuario):
//   · Fuente base Aptos Narrow 11.
//   · Encabezado de columnas en la fila 3: fondo oro (FFFFC000), centrado.
//   · Título en la fila 1: negrita + cursiva.
//   · Importes (Subtotal/IVA/Total) con formato #,##0.00 a la derecha.
//   · «Resumen»: Trasladado en rojo, Acreditable en verde, el resultado en azul
//     marino (negrita) y el pie «GDM NEXO / informes whatsapp …» en verde.
//
// EL PIE NO SE PUEDE QUITAR: A9:A10 quedan BLOQUEADAS y la hoja «Resumen» se
// protege con una contraseña ALEATORIA que no se guarda en ningún lado — ni el
// dueño puede quitar el candado. (La protección de Excel es un disuasivo, no un
// cifrado: con herramientas se puede romper; para algo inviolable iría un PDF.)
const NARROW   = 'Aptos Narrow';
const C_NEGRO  = 'FF000000';   // texto normal
const C_ROJO   = 'FFFF0000';   // IVA trasladado (cobrado)
const C_VERDE  = 'FF196B24';   // IVA acreditable + pie de marca (accent3 del archivo)
const C_AZUL   = 'FF002060';   // IVA a cargo / a favor
const C_ORO    = 'FFFFC000';   // fondo del encabezado
const FMT_PESOS = '#,##0.00';

async function construirXlsx(d, rfc, periodo) {
  const ExcelJS = require('exceljs');
  const crypto = require('crypto');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GDM NEXO';

  const enc = ['Tipo', 'Fecha', 'Serie', 'Folio', 'RFC Emisor', 'Nombre Emisor',
               'RFC Receptor', 'Nombre Receptor', 'Subtotal/Base', 'IVA', 'Total', 'Moneda', 'UUID'];
  const fila = (c) => [c.etiquetaTipo, c.fecha, c.serie, c.folio, c.rfcEmisor, c.nombreEmisor,
                       c.rfcReceptor, c.nombreReceptor, c.subtotal, c.iva, c.total, c.moneda, c.uuid];
  const COLS_IMPORTE = [9, 10, 11];   // Subtotal, IVA, Total (1-based)
  const COL_MONEDA = 12;

  const hojaDetalle = (titulo, lista, totalIva) => {
    const ws = wb.addWorksheet(titulo);
    const t = ws.getCell('A1');
    t.value = `${titulo} del periodo ${periodo} · RFC ${rfc}`;
    t.font = { name: NARROW, size: 11, bold: true, italic: true, color: { argb: C_NEGRO } };

    enc.forEach((txt, i) => {
      const cell = ws.getCell(3, i + 1);
      cell.value = txt;
      cell.font = { name: NARROW, size: 11, color: { argb: C_NEGRO } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_ORO } };
      cell.alignment = { horizontal: 'center' };
    });

    let r = 4;
    (lista || []).forEach((c) => {
      fila(c).forEach((v, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = v == null ? '' : v;
        cell.font = { name: NARROW, size: 11, color: { argb: C_NEGRO } };
        if (COLS_IMPORTE.includes(i + 1)) { cell.numFmt = FMT_PESOS; cell.alignment = { horizontal: 'right' }; }
        else if (i + 1 === COL_MONEDA) cell.alignment = { horizontal: 'center' };
      });
      r++;
    });
    const lastData = r - 1;

    r++;   // una fila en blanco antes del total
    const lbl = ws.getCell(r, 1);
    lbl.value = 'TOTAL ' + titulo.toUpperCase();
    lbl.font = { name: NARROW, size: 11, bold: true, color: { argb: C_NEGRO } };
    const tot = ws.getCell(r, 10);   // debajo de la columna IVA
    tot.value = Number(totalIva) || 0;
    tot.numFmt = FMT_PESOS;
    tot.alignment = { horizontal: 'right' };
    tot.font = { name: NARROW, size: 11, bold: true, color: { argb: C_NEGRO } };

    autofitColumnas(ws, enc.length, 3, lastData);
  };

  hojaDetalle('IVA cobrado', d.emitidos, d.ivaTraslado);
  hojaDetalle('IVA acreditable', d.recibidos, d.ivaAcreditable);

  // ── Resumen ──
  const rs = wb.addWorksheet('Resumen');
  rs.getColumn(1).width = 51;
  const setR = (addr, val, color, o = {}) => {
    const c = rs.getCell(addr);
    c.value = val;
    c.font = { name: NARROW, size: 11, color: { argb: color }, bold: !!o.bold, italic: !!o.italic };
    if (o.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    if (o.numFmt) c.numFmt = o.numFmt;
    if (o.align) c.alignment = { horizontal: o.align };
  };
  setR('A1', `Resumen de IVA del periodo ${periodo} · RFC ${rfc}`, C_NEGRO, { fill: C_ORO });
  setR('A3', 'IVA Trasladado (cobrado)', C_ROJO);
  setR('B3', Number(d.ivaTraslado) || 0, C_ROJO, { numFmt: FMT_PESOS });
  setR('A4', 'IVA Acreditable (pagado)', C_VERDE);
  setR('B4', Number(d.ivaAcreditable) || 0, C_VERDE, { numFmt: FMT_PESOS });
  setR('A5', d.aCargo ? 'IVA a cargo' : 'IVA a favor', C_AZUL);
  setR('B5', Math.round(Math.abs(d.resultado) * 100) / 100, C_AZUL, { numFmt: FMT_PESOS, bold: true });
  setR('A9', 'GDM NEXO', C_VERDE, { bold: true, italic: true, align: 'center' });
  setR('A10', 'informes whatsapp (449) 367 70 27', C_VERDE, { bold: true, italic: true });

  // Bloqueo del pie: se desbloquea el área escrita y se bloquea SOLO A9:A10; luego
  // se protege la hoja con una contraseña aleatoria que no se guarda (no se puede quitar).
  for (let rr = 1; rr <= 40; rr++) for (let cc = 1; cc <= 2; cc++) rs.getCell(rr, cc).protection = { locked: false };
  rs.getCell('A9').protection = { locked: true };
  rs.getCell('A10').protection = { locked: true };
  await rs.protect(crypto.randomBytes(24).toString('base64'), {
    selectLockedCells: true, selectUnlockedCells: true,
  });

  return await wb.xlsx.writeBuffer();
}

/** Ancho de columna aproximado al contenido (como el autoajuste de Excel), mirando
 *  SOLO el encabezado y los datos (no el título ni la fila de totales, que son textos
 *  largos en la columna A y la ensancharían de más). */
function autofitColumnas(ws, ncols, filaIni, filaFin) {
  for (let i = 1; i <= ncols; i++) {
    let max = 8;
    for (let r = filaIni; r <= filaFin; r++) {
      const v = ws.getCell(r, i).value;
      const s = v == null ? '' : (typeof v === 'number' ? v.toFixed(2) : String(v));
      if (s.length > max) max = s.length;
    }
    ws.getColumn(i).width = Math.min(max + 2, 80);
  }
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
