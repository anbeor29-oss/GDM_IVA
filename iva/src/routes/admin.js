'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const {
  getAdmin, updateAdminPassword,
  getAllUsuarios, getUsuarioById,
  createUsuario, updateUsuario, toggleUsuario, deleteUsuario
} = require('../db/database');

// Usar disco persistente en producción (Render: /var/data/efirmas)
// En desarrollo usa la carpeta local uploads/efirmas/
const UPLOADS_DIR = process.env.UPLOADS_DIR
  || path.join(__dirname, '..', '..', 'uploads', 'efirmas');

// Multer: guardar archivos en uploads/efirmas/{RFC}/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const rfc = (req.body.rfc || 'TEMP').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const dir = path.join(UPLOADS_DIR, rfc);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const nombre = ext === '.cer' ? 'certificado.cer' : 'llave.key';
    cb(null, nombre);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.cer' || ext === '.key') return cb(null, true);
    cb(new Error('Solo se permiten archivos .cer y .key'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Middleware: verificar sesión admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  res.redirect('/admin/login');
}

// ─── Login Admin ─────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session && req.session.adminId) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'admin', 'login.html'));
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admin = getAdmin(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.redirect('/admin/login?error=1');
  }
  req.session.adminId = admin.id;
  req.session.adminUser = admin.username;

  if (admin.primer_login) return res.redirect('/admin/cambiar-password');
  res.redirect('/admin/dashboard');
});

// ─── Cambiar contraseña (primer login) ───────────────────────────────────────
router.get('/cambiar-password', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'admin', 'cambiar-password.html'));
});

router.post('/cambiar-password', requireAdmin, (req, res) => {
  const { nueva, confirma } = req.body;
  if (!nueva || nueva.length < 8 || nueva !== confirma) {
    return res.redirect('/admin/cambiar-password?error=1');
  }
  updateAdminPassword(nueva, 0);
  res.redirect('/admin/dashboard');
});

// ─── Dashboard Admin ──────────────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'admin', 'dashboard.html'));
});

// API: lista de usuarios (llamada desde dashboard.html via fetch)
router.get('/api/usuarios', requireAdmin, (req, res) => {
  const usuarios = getAllUsuarios();
  res.json(usuarios);
});

// ─── Nuevo usuario ────────────────────────────────────────────────────────────
router.get('/usuarios/nuevo', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'admin', 'usuario-form.html'));
});

router.post('/usuarios/nuevo', requireAdmin,
  upload.fields([{ name: 'cer', maxCount: 1 }, { name: 'key', maxCount: 1 }]),
  (req, res) => {
    try {
      const { nombre, username, password, rfc, efirma_password } = req.body;

      if (!nombre || !username || !password || !rfc || !efirma_password) {
        return res.redirect('/admin/usuarios/nuevo?error=campos');
      }
      if (!req.files || !req.files.cer || !req.files.key) {
        return res.redirect('/admin/usuarios/nuevo?error=archivos');
      }

      const cerPath = req.files.cer[0].path;
      const keyPath = req.files.key[0].path;

      createUsuario({ nombre, username, password, rfc, cerPath, keyPath, efirmaPassword: efirma_password });
      res.redirect('/admin/dashboard?ok=nuevo');
    } catch (e) {
      console.error('Error creando usuario:', e.message);
      res.redirect('/admin/usuarios/nuevo?error=duplicado');
    }
  }
);

// ─── Editar usuario ───────────────────────────────────────────────────────────
router.get('/usuarios/:id/editar', requireAdmin, (req, res) => {
  const usuario = getUsuarioById(req.params.id);
  if (!usuario) return res.redirect('/admin/dashboard?error=noexiste');
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'admin', 'usuario-form.html'));
});

router.get('/api/usuarios/:id', requireAdmin, (req, res) => {
  const u = getUsuarioById(req.params.id);
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  // No devolver datos sensibles
  const { efirma_password_enc, password_hash, ...safe } = u;
  res.json(safe);
});

router.post('/usuarios/:id/editar', requireAdmin,
  upload.fields([{ name: 'cer', maxCount: 1 }, { name: 'key', maxCount: 1 }]),
  (req, res) => {
    try {
      const id = req.params.id;
      const { nombre, username, password, rfc, efirma_password } = req.body;

      const cerPath = req.files?.cer?.[0]?.path || null;
      const keyPath = req.files?.key?.[0]?.path || null;

      updateUsuario(id, {
        nombre, username, rfc,
        password: password || null,
        cerPath, keyPath,
        efirmaPassword: efirma_password || null
      });
      res.redirect('/admin/dashboard?ok=editado');
    } catch (e) {
      console.error('Error editando usuario:', e.message);
      res.redirect(`/admin/usuarios/${req.params.id}/editar?error=1`);
    }
  }
);

// ─── Activar / desactivar usuario ─────────────────────────────────────────────
router.post('/usuarios/:id/toggle', requireAdmin, (req, res) => {
  const u = getUsuarioById(req.params.id);
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  toggleUsuario(u.id, u.activo ? 0 : 1);
  res.json({ ok: true, activo: u.activo ? 0 : 1 });
});

// ─── Eliminar usuario ─────────────────────────────────────────────────────────
router.post('/usuarios/:id/eliminar', requireAdmin, (req, res) => {
  const u = getUsuarioById(req.params.id);
  if (!u) return res.redirect('/admin/dashboard?error=noexiste');

  // Eliminar archivos e-firma del servidor
  try {
    if (u.cer_path && fs.existsSync(u.cer_path)) fs.unlinkSync(u.cer_path);
    if (u.key_path && fs.existsSync(u.key_path)) fs.unlinkSync(u.key_path);
    const rfcDir = path.join(UPLOADS_DIR, u.rfc);
    if (fs.existsSync(rfcDir)) {
      const archivos = fs.readdirSync(rfcDir);
      if (archivos.length === 0) fs.rmdirSync(rfcDir);
    }
  } catch (_) {}

  deleteUsuario(u.id);
  res.redirect('/admin/dashboard?ok=eliminado');
});

// ─── Logout Admin ─────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

module.exports = router;
