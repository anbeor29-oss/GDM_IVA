'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const router = express.Router();

const { getUsuarioByUsername, decryptPassword } = require('../db/database');

// MODO PRUEBA: sin restricciÃ³n de fechas â€” cambiar a true en producciÃ³n
const MODO_PRODUCCION = false;
function dentroDeVentana() {
  if (!MODO_PRODUCCION) return true;
  const dia = new Date().getDate();
  return dia >= 3 && dia <= 28;
}

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'login.html'));
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

  if (!usuario.cer_path || !usuario.key_path || !usuario.efirma_password_enc) {
    return res.redirect('/login?error=efirma');
  }

  // Cargar datos e-firma en sesiÃ³n (contraseÃ±a descifrada en RAM)
  req.session.userId = usuario.id;
  req.session.nombre = usuario.nombre;
  req.session.rfc = usuario.rfc;
  req.session.cerPath = usuario.cer_path;
  req.session.keyPath = usuario.key_path;
  req.session.efirmaPassword = decryptPassword(usuario.efirma_password_enc);

  res.redirect('/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
