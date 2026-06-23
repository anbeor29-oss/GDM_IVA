'use strict';

/**
 * Rutas auxiliares para PWA:
 *  - GET /pwa/install     → página standalone con instrucciones de instalación
 *  - GET /pwa/share-whatsapp → genera link para compartir por WhatsApp
 */

const express = require('express');
const path    = require('path');
const router  = express.Router();

// Página de bienvenida (para usuarios que entran por link de WhatsApp)
router.get('/install', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'pwa-install.html'));
});

// Genera link pre-llenado para compartir por WhatsApp
router.get('/share-whatsapp', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const mensaje = encodeURIComponent(
    `🧾 *Portal de IVA — Grupo GDM High Consulting México*\n\n` +
    `Consulta tu IVA mensual del SAT directo desde tu celular.\n\n` +
    `📲 Instala la app:\n${baseUrl}/pwa/install\n\n` +
    `1. Abre el link en Chrome (Android) o Safari (iPhone)\n` +
    `2. Toca el botón "📲 Instalar app"\n` +
    `3. Listo, queda en tu pantalla de inicio`
  );
  res.redirect(`https://api.whatsapp.com/send?text=${mensaje}`);
});

module.exports = router;
