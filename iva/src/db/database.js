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
}

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
  return db.prepare(`SELECT id, nombre, username, rfc, activo, estado, origen,
                            pruebas_usadas, pruebas_max, vigencia_fin, created_at
                     FROM usuarios ORDER BY origen DESC, nombre`).all();
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

/** Alta pública de prospecto (autoregistro). Devuelve { id, tempPassword }. */
function crearAutoRegistro({ nombre, email, rfc, cp, regimen }) {
  const temp = generarPasswordTemporal();
  const hash = bcrypt.hashSync(temp, 12);
  const info = db.prepare(`
    INSERT INTO usuarios (nombre, username, password_hash, rfc, cp, regimen,
                          estado, origen, pruebas_usadas, pruebas_max, must_change_password, activo)
    VALUES (?, ?, ?, ?, ?, ?, 'PRUEBA', 'AUTOREGISTRO', 0, 2, 1, 1)
  `).run(nombre, email, hash, rfc.toUpperCase(), cp || null, regimen || null);
  return { id: info.lastInsertRowid, tempPassword: temp };
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

/** Marca pagado: ACTIVO con vigencia de `dias` (365 por defecto). Devuelve la fecha fin. */
function marcarPagado(id, dias = 365) {
  const fin = new Date();
  fin.setDate(fin.getDate() + dias);
  const finStr = fin.toISOString().slice(0, 10);
  db.prepare("UPDATE usuarios SET estado = 'ACTIVO', vigencia_fin = ? WHERE id = ?").run(finStr, id);
  return finStr;
}

/** Marca "no pagado": BLOQUEADO (no puede consultar) y borra la vigencia. */
function bloquearComercial(id) {
  db.prepare("UPDATE usuarios SET estado = 'BLOQUEADO', vigencia_fin = NULL WHERE id = ?").run(id);
}

/** ¿Puede usar el servicio? Resuelve prueba / vigencia / bloqueo. */
function estadoAcceso(u) {
  if (!u) return { puede: false, motivo: 'no-usuario' };
  if (!u.activo) return { puede: false, motivo: 'inactivo' };
  if (u.origen === 'ADMIN') return { puede: true, motivo: 'cliente' };      // clientes GDM: sin límite
  if (u.estado === 'BLOQUEADO') return { puede: false, motivo: 'bloqueado' };
  if (u.estado === 'PRUEBA') {
    const restantes = Math.max(0, (u.pruebas_max || 2) - (u.pruebas_usadas || 0));
    return restantes > 0
      ? { puede: true, motivo: 'prueba', pruebasRestantes: restantes }
      : { puede: false, motivo: 'prueba-agotada' };
  }
  if (u.estado === 'ACTIVO') {
    if (u.vigencia_fin) {
      const dias = Math.ceil((new Date(u.vigencia_fin + 'T23:59:59') - new Date()) / 86400000);
      return dias > 0 ? { puede: true, motivo: 'activo', diasRestantes: dias } : { puede: false, motivo: 'vencido' };
    }
    return { puede: true, motivo: 'activo' };
  }
  return { puede: false, motivo: 'desconocido' };
}

module.exports = {
  db,
  getAdmin, updateAdminPassword,
  getAllUsuarios, getUsuarioById, getUsuarioByUsername,
  createUsuario, updateUsuario, toggleUsuario, deleteUsuario,
  encryptPassword, decryptPassword,
  crearAutoRegistro, setPasswordUsuario, setEfirmaUsuario,
  registrarConsultaPrueba, marcarPagado, bloquearComercial, estadoAcceso
};
