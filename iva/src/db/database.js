'use strict';
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Usar disco persistente en producción (Render: /var/data)
// En desarrollo usa la carpeta local data/
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'iva.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    primer_login INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rfc TEXT NOT NULL,
    cer_path TEXT,
    key_path TEXT,
    efirma_password_enc TEXT,
    activo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ─── Migración: columnas de comercialización (auto-registro, prueba, vigencia) ──
// Los usuarios creados por el ADMIN son clientes GDM (origen ADMIN, estado ACTIVO,
// sin límite). Los de AUTOREGISTRO entran en PRUEBA (2 consultas) → BLOQUEADO →
// ACTIVO con vigencia de 365 días al pagar ($500 + IVA anual).
{
  const cols = db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name);
  const addCol = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE usuarios ADD COLUMN ${ddl}`); };
  addCol('cp', 'cp TEXT');
  addCol('regimen', 'regimen TEXT');
  addCol('estado', "estado TEXT NOT NULL DEFAULT 'ACTIVO'");           // ACTIVO | PRUEBA | BLOQUEADO
  addCol('origen', "origen TEXT NOT NULL DEFAULT 'ADMIN'");            // ADMIN | AUTOREGISTRO
  addCol('pruebas_usadas', 'pruebas_usadas INTEGER NOT NULL DEFAULT 0');
  addCol('pruebas_max', 'pruebas_max INTEGER NOT NULL DEFAULT 2');
  addCol('vigencia_fin', 'vigencia_fin TEXT');                        // fecha (YYYY-MM-DD) fin de la anualidad pagada
  addCol('must_change_password', 'must_change_password INTEGER NOT NULL DEFAULT 0');
  // Derecho a descargar a Excel. Por defecto 0 (apagado) para TODOS, incluidos los
  // clientes GDM (origen ADMIN): la descarga a Excel es un extra que se paga. Se
  // enciende con el checkbox del admin, o automáticamente al "Marcar pagado" (la
  // anualidad de autoregistro ya incluye Excel).
  addCol('excel_habilitado', 'excel_habilitado INTEGER NOT NULL DEFAULT 0');
  // CRM / registro comercial (Aviso de Privacidad LFPDPPP + contacto)
  addCol('telefono', 'telefono TEXT');
  addCol('empresa', 'empresa TEXT');
  addCol('como_conocio', 'como_conocio TEXT');
  addCol('aviso_at', 'aviso_at TEXT');                                // sello de aceptación del Aviso de Privacidad
  addCol('aviso_version', 'aviso_version TEXT');
}

// ─── Comercialización: CRÉDITOS (prepago), BITÁCORA de uso y PAGOS ────────────
// Modelo: 1 crédito = 1 CONSULTA (la operación pesada contra el SAT/SatGo). La
// exportación a Excel de un mes ya consultado NO vuelve a cobrar. El saldo se
// deriva de un libro (suma de `delta`), nunca se guarda un número suelto.
db.exec(`
  CREATE TABLE IF NOT EXISTS creditos_mov (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,                 -- +compra/alta, -consumo, ± ajuste
    tipo TEXT NOT NULL,                     -- ALTA | COMPRA | CONSUMO | AJUSTE
    concepto TEXT,
    periodo TEXT,                           -- AAAAMM de la consulta, si aplica
    rfc TEXT,
    admin_user TEXT,                        -- quién acreditó (si fue el admin)
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS ix_creditos_usuario ON creditos_mov(usuario_id);

  CREATE TABLE IF NOT EXISTS uso (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    rfc TEXT,
    periodo TEXT,
    tipo TEXT NOT NULL,                     -- CONSULTA | EXPORT
    via TEXT,                               -- cliente | activo | prueba | creditos
    resultado TEXT,                         -- OK | ERROR | INICIADA | BLOQUEADO
    detalle TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS ix_uso_usuario ON uso(usuario_id);

  CREATE TABLE IF NOT EXISTS pagos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    monto REAL,
    concepto TEXT,
    metodo TEXT,                            -- TRANSFERENCIA | EFECTIVO | TARJETA | OTRO
    referencia TEXT,
    creditos INTEGER DEFAULT 0,             -- créditos acreditados por este pago
    admin_user TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS ix_pagos_usuario ON pagos(usuario_id);
`);

// Crear admin por defecto si no existe
const adminExiste = db.prepare('SELECT id FROM admin WHERE id = 1').get();
if (!adminExiste) {
  const hash = bcrypt.hashSync('Admin1234!', 12);
  db.prepare('INSERT INTO admin (id, username, password_hash, primer_login) VALUES (1, ?, ?, 1)')
    .run('admin', hash);
  console.log('Admin creado por defecto. Usuario: admin | Contraseña: Admin1234!');
  console.log('IMPORTANTE: Cambia la contraseña en el primer login.');
}

// ─── Cifrado de contraseña e-firma ──────────────────────────────────────────
// Usa AES-256-GCM con IV aleatorio. La clave se deriva del SESSION_SECRET.
function getEncryptionKey() {
  const secret = process.env.SESSION_SECRET || 'clave-insegura-cambia-esto';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptPassword(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptPassword(stored) {
  const [ivHex, tagHex, encHex] = stored.split(':');
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// ─── Queries Admin ───────────────────────────────────────────────────────────
function getAdmin(username) {
  return db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
}

function updateAdminPassword(newPassword, primerLogin = 0) {
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE admin SET password_hash = ?, primer_login = ? WHERE id = 1')
    .run(hash, primerLogin);
}

// ─── Queries Usuarios ────────────────────────────────────────────────────────
function getAllUsuarios() {
  return db.prepare(`SELECT u.id, u.nombre, u.username, u.rfc, u.activo, u.estado, u.origen,
                            u.pruebas_usadas, u.pruebas_max, u.vigencia_fin, u.excel_habilitado, u.created_at,
                            u.telefono, u.empresa, u.como_conocio, u.aviso_at,
                            COALESCE((SELECT SUM(delta) FROM creditos_mov c WHERE c.usuario_id = u.id), 0) AS creditos
                     FROM usuarios u ORDER BY u.origen DESC, u.nombre`).all();
}

function getUsuarioById(id) {
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
}

function getUsuarioByUsername(username) {
  return db.prepare('SELECT * FROM usuarios WHERE username = ? AND activo = 1').get(username);
}

function createUsuario({ nombre, username, password, rfc, cerPath, keyPath, efirmaPassword }) {
  const hash = bcrypt.hashSync(password, 12);
  const enc = encryptPassword(efirmaPassword);
  return db.prepare(`
    INSERT INTO usuarios (nombre, username, password_hash, rfc, cer_path, key_path, efirma_password_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nombre, username, hash, rfc.toUpperCase(), cerPath, keyPath, enc);
}

function updateUsuario(id, { nombre, username, password, rfc, cerPath, keyPath, efirmaPassword }) {
  // Construir update dinámico según qué campos se proporcionaron
  const sets = ['nombre = ?', 'username = ?', 'rfc = ?'];
  const vals = [nombre, username, rfc.toUpperCase()];

  if (password) {
    sets.push('password_hash = ?');
    vals.push(bcrypt.hashSync(password, 12));
  }
  if (cerPath) {
    sets.push('cer_path = ?');
    vals.push(cerPath);
  }
  if (keyPath) {
    sets.push('key_path = ?');
    vals.push(keyPath);
  }
  if (efirmaPassword) {
    sets.push('efirma_password_enc = ?');
    vals.push(encryptPassword(efirmaPassword));
  }

  vals.push(id);
  db.prepare(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function toggleUsuario(id, activo) {
  db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo, id);
}

function deleteUsuario(id) {
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
}

// ─── Comercialización: auto-registro, prueba y vigencia ──────────────────────
function generarPasswordTemporal() {
  const c = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  return (c.slice(0, 8) || 'Temporal') + Math.floor(10 + Math.random() * 89); // ~10 chars legibles
}

/** Alta pública de prospecto (autoregistro). Guarda también el CRM (teléfono,
 *  empresa, cómo nos conoció) y el sello de aceptación del Aviso de Privacidad.
 *  Devuelve { id, tempPassword }. */
function crearAutoRegistro({ nombre, email, rfc, cp, regimen, telefono, empresa, comoConocio, avisoVersion }) {
  const temp = generarPasswordTemporal();
  const hash = bcrypt.hashSync(temp, 12);
  const avisoAt = avisoVersion ? new Date().toISOString() : null;
  const info = db.prepare(`
    INSERT INTO usuarios (nombre, username, password_hash, rfc, cp, regimen,
                          telefono, empresa, como_conocio, aviso_at, aviso_version,
                          estado, origen, pruebas_usadas, pruebas_max, must_change_password, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PRUEBA', 'AUTOREGISTRO', 0, 2, 1, 1)
  `).run(nombre, email, hash, rfc.toUpperCase(), cp || null, regimen || null,
         telefono || null, empresa || null, comoConocio || null, avisoAt, avisoVersion || null);
  return { id: info.lastInsertRowid, tempPassword: temp };
}

// ─── Créditos (prepago), bitácora de uso y pagos ─────────────────────────────
/** Saldo de créditos del usuario (suma del libro). */
function saldoCreditos(usuarioId) {
  const r = db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM creditos_mov WHERE usuario_id = ?').get(usuarioId);
  return r ? r.s : 0;
}

/** Asienta un movimiento de créditos y devuelve el saldo nuevo. */
function moverCreditos(usuarioId, delta, tipo, { concepto, periodo, rfc, adminUser } = {}) {
  db.prepare(`INSERT INTO creditos_mov (usuario_id, delta, tipo, concepto, periodo, rfc, admin_user)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(usuarioId, delta, tipo, concepto || null, periodo || null, rfc || null, adminUser || null);
  return saldoCreditos(usuarioId);
}

/** Registra una línea en la bitácora de uso (consulta/export). */
function registrarUso(usuarioId, { rfc, periodo, tipo, via, resultado, detalle } = {}) {
  db.prepare(`INSERT INTO uso (usuario_id, rfc, periodo, tipo, via, resultado, detalle)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(usuarioId, rfc || null, periodo || null, tipo, via || null, resultado || null, detalle || null);
}

/** Acredita un pago manual: guarda el abono y suma los créditos comprados.
 *  Si trae `dias`, además activa/renueva la anualidad (ACTIVO). */
function acreditarPago(usuarioId, { monto, concepto, metodo, referencia, creditos = 0, dias, adminUser } = {}) {
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO pagos (usuario_id, monto, concepto, metodo, referencia, creditos, admin_user)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(usuarioId, monto || 0, concepto || null, metodo || null, referencia || null, creditos || 0, adminUser || null);
    if (creditos && creditos > 0) {
      moverCreditos(usuarioId, creditos, 'COMPRA', { concepto: concepto || 'Compra de créditos', adminUser });
    }
    if (dias && dias > 0) marcarPagado(usuarioId, dias);
  });
  tx();
  return { saldo: saldoCreditos(usuarioId) };
}

/** Bitácora de uso (toda, o de un usuario). */
function listarUso(usuarioId) {
  return usuarioId
    ? db.prepare('SELECT * FROM uso WHERE usuario_id = ? ORDER BY id DESC LIMIT 500').all(usuarioId)
    : db.prepare('SELECT * FROM uso ORDER BY id DESC LIMIT 500').all();
}

/** Pagos (todos, o de un usuario). */
function listarPagos(usuarioId) {
  return usuarioId
    ? db.prepare('SELECT * FROM pagos WHERE usuario_id = ? ORDER BY id DESC').all(usuarioId)
    : db.prepare('SELECT * FROM pagos ORDER BY id DESC').all();
}

/** Cambia la contraseña y quita la bandera de cambio obligatorio. */
function setPasswordUsuario(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE usuarios SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, id);
}

/** Guarda la e.firma del usuario (rutas + contraseña cifrada). */
function setEfirmaUsuario(id, { cerPath, keyPath, efirmaPassword }) {
  const enc = encryptPassword(efirmaPassword);
  db.prepare('UPDATE usuarios SET cer_path = ?, key_path = ?, efirma_password_enc = ? WHERE id = ?')
    .run(cerPath, keyPath, enc, id);
}

/** Cuenta una consulta de PRUEBA; bloquea al llegar al máximo. { restantes, bloqueado }. */
function registrarConsultaPrueba(id) {
  const u = db.prepare('SELECT estado, pruebas_usadas, pruebas_max FROM usuarios WHERE id = ?').get(id);
  if (!u || u.estado !== 'PRUEBA') return { restantes: null, bloqueado: false };
  const usadas = (u.pruebas_usadas || 0) + 1;
  const bloqueado = usadas >= (u.pruebas_max || 2);
  db.prepare('UPDATE usuarios SET pruebas_usadas = ?, estado = ? WHERE id = ?')
    .run(usadas, bloqueado ? 'BLOQUEADO' : 'PRUEBA', id);
  return { restantes: Math.max(0, (u.pruebas_max || 2) - usadas), bloqueado };
}

/** Marca pagado: ACTIVO con vigencia de `dias` (365 por defecto) y Excel habilitado
 *  (la anualidad de autoregistro ya incluye la descarga a Excel). Devuelve la fecha fin. */
function marcarPagado(id, dias = 365) {
  const fin = new Date();
  fin.setDate(fin.getDate() + dias);
  const finStr = fin.toISOString().slice(0, 10);
  db.prepare("UPDATE usuarios SET estado = 'ACTIVO', vigencia_fin = ?, excel_habilitado = 1 WHERE id = ?").run(finStr, id);
  return finStr;
}

/** Marca "no pagado": BLOQUEADO (no puede consultar), borra vigencia y quita Excel. */
function bloquearComercial(id) {
  db.prepare("UPDATE usuarios SET estado = 'BLOQUEADO', vigencia_fin = NULL, excel_habilitado = 0 WHERE id = ?").run(id);
}

/** Habilita/deshabilita la descarga a Excel de un usuario (checkbox del admin). */
function setExcelHabilitado(id, on) {
  db.prepare('UPDATE usuarios SET excel_habilitado = ? WHERE id = ?').run(on ? 1 : 0, id);
}

/** ¿Puede usar el servicio? Resuelve, en orden: cliente GDM · anualidad vigente ·
 *  prueba con consultas · créditos prepago · bloqueo. Los créditos prepago sirven
 *  aun si la prueba se agotó, la anualidad venció o el admin lo bloqueó. */
function estadoAcceso(u) {
  if (!u) return { puede: false, motivo: 'no-usuario' };
  if (!u.activo) return { puede: false, motivo: 'inactivo' };
  if (u.origen === 'ADMIN') return { puede: true, motivo: 'cliente' };      // clientes GDM: sin límite

  // 1) Anualidad ($500+IVA/año): mientras esté vigente, sin límite.
  if (u.estado === 'ACTIVO') {
    if (u.vigencia_fin) {
      const dias = Math.ceil((new Date(u.vigencia_fin + 'T23:59:59') - new Date()) / 86400000);
      if (dias > 0) return { puede: true, motivo: 'activo', diasRestantes: dias };
      // vencida → cae a créditos abajo
    } else {
      return { puede: true, motivo: 'activo' };   // marcado ACTIVO sin fecha (cliente)
    }
  }

  // 2) Prueba con consultas restantes.
  if (u.estado === 'PRUEBA') {
    const restantes = Math.max(0, (u.pruebas_max || 2) - (u.pruebas_usadas || 0));
    if (restantes > 0) return { puede: true, motivo: 'prueba', pruebasRestantes: restantes };
  }

  // 3) Créditos prepago (paquetes comprados).
  const cr = saldoCreditos(u.id);
  if (cr > 0) return { puede: true, motivo: 'creditos', creditosRestantes: cr };

  // 4) Sin acceso: el motivo explica el porqué.
  if (u.estado === 'BLOQUEADO') return { puede: false, motivo: 'bloqueado' };
  if (u.estado === 'PRUEBA') return { puede: false, motivo: 'prueba-agotada' };
  if (u.estado === 'ACTIVO') return { puede: false, motivo: 'vencido' };
  return { puede: false, motivo: 'sin-creditos' };
}

/** Consume acceso para una operación y la registra en la bitácora.
 *  CONSULTA: cliente/activo = sin costo; prueba = baja una prueba; créditos = −1.
 *  EXPORT: no cobra (el mes ya se pagó al consultarlo), solo se registra.
 *  Devuelve { ok, via, restantes? } o { ok:false, motivo }. */
function consumir(usuarioId, tipoUso, { rfc, periodo } = {}) {
  const u = getUsuarioById(usuarioId);
  const acc = estadoAcceso(u);
  if (!acc.puede) {
    registrarUso(usuarioId, { rfc, periodo, tipo: tipoUso, resultado: 'BLOQUEADO', detalle: acc.motivo });
    return { ok: false, motivo: acc.motivo };
  }
  const via = acc.motivo;
  let restantes = null;
  if (tipoUso === 'CONSULTA') {
    if (via === 'prueba') {
      restantes = registrarConsultaPrueba(usuarioId).restantes;
    } else if (via === 'creditos') {
      restantes = moverCreditos(usuarioId, -1, 'CONSUMO', { concepto: 'Consulta de IVA', periodo, rfc });
    }
    // cliente / activo: sin costo
  }
  registrarUso(usuarioId, { rfc, periodo, tipo: tipoUso, via, resultado: 'OK' });
  return { ok: true, via, restantes };
}

module.exports = {
  db,
  getAdmin, updateAdminPassword,
  getAllUsuarios, getUsuarioById, getUsuarioByUsername,
  createUsuario, updateUsuario, toggleUsuario, deleteUsuario,
  encryptPassword, decryptPassword,
  crearAutoRegistro, setPasswordUsuario, setEfirmaUsuario,
  registrarConsultaPrueba, marcarPagado, bloquearComercial, estadoAcceso,
  setExcelHabilitado,
  saldoCreditos, moverCreditos, registrarUso, acreditarPago, listarUso, listarPagos, consumir
};
