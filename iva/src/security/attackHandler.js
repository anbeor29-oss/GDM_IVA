'use strict';
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'security.log');
const logsDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function log(message) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch (_) {}
  console.warn(entry.trim());
}

let _invalidateSATSession = null;

function registerSATInvalidator(fn) {
  _invalidateSATSession = fn;
}

function handleAttack(req, type) {
  const ip = req.ip || req.connection.remoteAddress;
  const url = req.originalUrl;
  const ua = req.headers['user-agent'] || 'unknown';
  log(`ATAQUE [${type}] IP=${ip} URL=${url} UA=${ua}`);

  if (typeof _invalidateSATSession === 'function') {
    try {
      _invalidateSATSession();
      log(`SAT_SESSION_INVALIDATED por ataque IP=${ip}`);
    } catch (e) {
      log(`ERROR invalidando sesión SAT: ${e.message}`);
    }
  }

  if (req.session) req.session.destroy(() => {});
}

module.exports = { handleAttack, registerSATInvalidator, log };
