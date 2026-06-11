'use strict';
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

// En Render/Heroku el filesystem es efímero, así que las IPs bloqueadas
// se manejan en memoria y se borran al reiniciar el servicio.
const BLOCKED_IPS_FILE = path.join(__dirname, '..', '..', 'blocked-ips.json');

function loadBlockedIPs() {
  try {
    if (fs.existsSync(BLOCKED_IPS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(BLOCKED_IPS_FILE, 'utf8')));
    }
  } catch (_) {}
  return new Set();
}

function saveBlockedIPs(set) {
  try {
    fs.writeFileSync(BLOCKED_IPS_FILE, JSON.stringify([...set]), 'utf8');
  } catch (_) {}
}

const blockedIPs = loadBlockedIPs();

function blockIP(ip) {
  blockedIPs.add(ip);
  saveBlockedIPs(blockedIPs);
  // Auto-desbloqueo después de 30 minutos (evita bloqueos permanentes accidentales)
  setTimeout(() => {
    blockedIPs.delete(ip);
    saveBlockedIPs(blockedIPs);
  }, 30 * 60 * 1000);
}

function isBlocked(ip) {
  return blockedIPs.has(ip);
}

function ipBlockMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  if (isBlocked(ip)) {
    return res.redirect('/error-ataque.html');
  }
  next();
}

// ── Global limiter: solo retorna 429, NO bloquea IP permanentemente ──────────
// En producción los recursos estáticos (CSS, JS, favicon) cuentan en este
// limiter y un usuario normal puede llegar a 100 req en pocos minutos.
// 500 req / 15 min es suficiente para uso normal y bloquea bots reales.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  // Sin handler personalizado → retorna 429 estándar sin bloquear IP
  message: { error: 'Demasiadas peticiones. Espera un momento.' }
});

// ── Login limiter: 5 intentos fallidos / 15 min — SÍ bloquea (brute force) ──
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Solo cuenta intentos fallidos (skipSuccessfulRequests)
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    blockIP(req.ip);
    require('./attackHandler').handleAttack(req, 'BRUTE_FORCE_LOGIN');
    res.redirect('/error-ataque.html');
  }
});

// ── SAT limiter: 10 req / min — protege el token y el límite diario del SAT ─
// NO bloquea IP permanentemente, solo retorna 429
const satLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones al SAT. Espera 1 minuto.' }
});

module.exports = { globalLimiter, loginLimiter, satLimiter, ipBlockMiddleware, blockIP, isBlocked };
