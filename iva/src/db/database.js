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
  return db.prepare('SELECT id, nombre, username, rfc, activo, created_at FROM usuarios ORDER BY nombre').all();
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

module.exports = {
  db,
  getAdmin, updateAdminPassword,
  getAllUsuarios, getUsuarioById, getUsuarioByUsername,
  createUsuario, updateUsuario, toggleUsuario, deleteUsuario,
  encryptPassword, decryptPassword
};
