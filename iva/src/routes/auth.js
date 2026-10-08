'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const {
  getUsuarioByUsername, getUsuarioById, decryptPassword,
  crearAutoRegistro, setPasswordUsuario, setEfirmaUsuario, estadoAcceso,
} = require('../db/database');

const VIEWS = path.join(__dirname, '..', '..', 'views');
const PUBLIC = path.join(__dirname, '..', '..', 'public');
// En producción (Render) la e.firma va al disco persistente (UPLOADS_DIR=/var/data/efirmas).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads', 'efirmas');

// MODO PRODUCCIÓN: la consulta sólo del día 3 al 29. (Igual que el resto de la app.)
const MODO_PRODUCCION = true;
function dentroDeVentana() {
  if (!MODO_PRODUCCION) return true;
  const dia = new Date().getDate();
  return dia >= 3 && dia <= 29;
}

function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

/** Carga la e.firma del usuario en la sesión (contraseña descifrada en RAM). */
function cargarEfirmaEnSesion(req, usuario, passwordPlano) {
  req.session.cerPath = usuario.cer_path;
  req.session.keyPath = usuario.key_path;
  req.session.efirmaPassword = passwordPlano != null
    ? passwordPlano
    : decryptPassword(usuario.efirma_password_enc);
}

/** A dónde mandar al usuario según su estado (cambio de pass → e.firma → bloqueo → dashboard). */
function siguientePaso(usuario, req) {
  if (usuario.must_change_password) return '/cambiar-password';
  const acc = estadoAcceso(usuario);
  if (!acc.puede) return '/bloqueado';
  if (!req.session.cerPath) return '/configurar-efirma';
  return '/dashboard';
}

// ─── Multer: e.firma del propio usuario → uploads/efirmas/{RFC}/ ───────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const rfc = String(req.session.rfc || 'TEMP').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const dir = path.join(UPLOADS_DIR, rfc);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ext === '.cer' ? 'certificado.cer' : 'llave.key');
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.cer' || ext === '.key') return cb(null, true);
    cb(new Error('Solo se permiten archivos .cer y .key'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ─── Login ─────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const usuario = getUsuarioByUsername(username);
  if (!usuario || !bcrypt.compareSync(password, usuario.password_hash)) {
    return res.redirect('/login?error=credenciales');
  }
  if (!dentroDeVentana()) {
    return res.redirect('/login?error=ventana');
  }

  // Sesión base (sin exigir e.firma: los de prueba la suben después).
  req.session.userId = usuario.id;
  req.session.nombre = usuario.nombre;
  req.session.rfc = usuario.rfc;
  req.session.estado = usuario.estado;
  req.session.origen = usuario.origen;
  if (usuario.cer_path && usuario.key_path && usuario.efirma_password_enc) {
    cargarEfirmaEnSesion(req, usuario);
  }

  res.redirect(siguientePaso(usuario, req));
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ─── Interés / oferta (pantalla "no eres cliente") ─────────────────────────────
// La página en sí es estática: public/acceso-denegado.html (la oferta + WhatsApp).

// ─── Registro (autoservicio: prueba gratis) ────────────────────────────────────
router.get('/registro', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(VIEWS, 'registro.html'));
});

router.post('/registro', (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const rfc = String(req.body.rfc || '').trim().toUpperCase();
    const cp = String(req.body.cp || '').trim();
    const regimen = String(req.body.regimen || '').trim();

    if (!nombre || !email || !rfc || !cp || !regimen) {
      return res.redirect('/registro?error=campos');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect('/registro?error=correo');
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) return res.redirect('/registro?error=rfc');

    // El correo es el usuario → no debe existir.
    if (getUsuarioByUsername(email)) return res.redirect('/registro?error=existe');

    const { tempPassword } = crearAutoRegistro({ nombre, email, rfc, cp, regimen });
    // Se muestra UNA vez en la pantalla de éxito (no viaja por URL).
    req.session.registroExito = { username: email, tempPassword };
    res.redirect('/registro-exito');
  } catch (e) {
    const dup = /UNIQUE/.test(e.message || '');
    res.redirect('/registro?error=' + (dup ? 'existe' : 'error'));
  }
});

router.get('/registro-exito', (req, res) => {
  if (!req.session.registroExito) return res.redirect('/registro');
  res.sendFile(path.join(VIEWS, 'registro-exito.html'));
});

// Entrega las credenciales temporales UNA sola vez y las borra de la sesión.
router.get('/api/registro-exito', (req, res) => {
  const data = req.session.registroExito;
  if (!data) return res.status(404).json({ error: 'sin-datos' });
  delete req.session.registroExito;
  res.json(data);
});

// ─── Cambiar contraseña (obligatorio en el primer acceso) ──────────────────────
router.get('/cambiar-password', requireUser, (req, res) => {
  res.sendFile(path.join(VIEWS, 'cambiar-password-usuario.html'));
});

router.post('/cambiar-password', requireUser, (req, res) => {
  const { nueva, confirma } = req.body;
  if (!nueva || nueva.length < 8 || nueva !== confirma) {
    return res.redirect('/cambiar-password?error=1');
  }
  setPasswordUsuario(req.session.userId, nueva);
  const usuario = getUsuarioById(req.session.userId);
  res.redirect(siguientePaso(usuario, req));
});

// ─── Configurar e.firma (necesaria para consultar) ─────────────────────────────
router.get('/configurar-efirma', requireUser, (req, res) => {
  res.sendFile(path.join(VIEWS, 'configurar-efirma.html'));
});

router.post('/configurar-efirma', requireUser,
  upload.fields([{ name: 'cer', maxCount: 1 }, { name: 'key', maxCount: 1 }]),
  (req, res) => {
    try {
      const efirmaPassword = String(req.body.efirma_password || '');
      if (!req.files || !req.files.cer || !req.files.key || !efirmaPassword) {
        return res.redirect('/configurar-efirma?error=campos');
      }
      const cerPath = req.files.cer[0].path;
      const keyPath = req.files.key[0].path;
      setEfirmaUsuario(req.session.userId, { cerPath, keyPath, efirmaPassword });
      // Cargar en sesión para poder consultar de inmediato.
      req.session.cerPath = cerPath;
      req.session.keyPath = keyPath;
      req.session.efirmaPassword = efirmaPassword;

      const usuario = getUsuarioById(req.session.userId);
      const acc = estadoAcceso(usuario);
      res.redirect(acc.puede ? '/dashboard' : '/bloqueado');
    } catch (e) {
      res.redirect('/configurar-efirma?error=1');
    }
  }
);

// ─── Bloqueado / fin de prueba → pago ──────────────────────────────────────────
router.get('/bloqueado', requireUser, (req, res) => {
  res.sendFile(path.join(VIEWS, 'bloqueado.html'));
});

module.exports = router;
