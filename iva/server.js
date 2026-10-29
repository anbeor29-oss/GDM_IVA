'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const { globalLimiter, loginLimiter, ipBlockMiddleware } = require('./src/security/rateLimiter');
const { iniciarScheduler } = require('./src/scheduler/tasks');

const adminRoutes     = require('./src/routes/admin');
const authRoutes      = require('./src/routes/auth');
const dashboardRoutes = require('./src/routes/dashboard');

// La sesión se guarda en SQLite (disco persistente), no en memoria: así
// sobrevive a los reinicios de Render (deploy / spin-down) y el admin no se
// sale solo ni se "caen" las acciones del panel. Ver src/db/session-store.js.
const { db } = require('./src/db/database');
const SqliteSessionStore = require('./src/db/session-store');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Detrás de Apache/cPanel (proxy reverso) ─────────────────────────────────
// Necesario para que express-session detecte HTTPS y ponga cookies secure
app.set('trust proxy', 1);

// ─── BASE_PATH para montaje bajo subruta (ej. /iva en cPanel) ────────────────
// Prefija automáticamente todas las redirecciones con res.redirect('/login')
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
app.use((req, res, next) => {
  res.locals.basePath = BASE_PATH;
  const original = res.redirect.bind(res);
  res.redirect = function(arg1, arg2) {
    let status, url;
    if (typeof arg1 === 'number') { status = arg1; url = arg2; }
    else { url = arg1; }
    if (BASE_PATH && typeof url === 'string' && url.startsWith('/')) {
      url = BASE_PATH + url;
    }
    return status ? original(status, url) : original(url);
  };
  next();
});

// Crear carpeta temporal de XMLs si no existe (Windows: C:\temp2xml ; Linux: /tmp/temp2xml)
const DEFAULT_TEMP = process.platform === 'win32' ? 'C:\\temp2xml' : '/tmp/temp2xml';
const TEMP_XML_PATH = process.env.TEMP_XML_PATH || DEFAULT_TEMP;
if (!fs.existsSync(TEMP_XML_PATH)) {
  fs.mkdirSync(TEMP_XML_PATH, { recursive: true });
  console.log(`Carpeta creada: ${TEMP_XML_PATH}`);
}

// ─── Seguridad HTTP ───────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));

// Bloquear IPs en lista negra (primero que todo)
app.use(ipBlockMiddleware);

// Rate limiter global
app.use(globalLimiter);

// ─── Parseo de body ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Sesiones ─────────────────────────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === 'production';
// Cookie "secure": por defecto true en producción (lo correcto con HTTPS). SÓLO si
// Cloudflare quedó en modo "Flexible" (Cloudflare→origen por HTTP) el origen ve la
// petición como insegura y, con secure:true, la cookie de sesión NUNCA se guarda y
// el login "no deja entrar". En ESE caso —y sólo ese— se puede poner la variable
// COOKIE_SECURE=false como escape; lo recomendable es dejar Cloudflare en Full SSL
// y no tocar esto. El default NO se debilita.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'false' ? false
  : process.env.COOKIE_SECURE === 'true' ? true
  : IS_PROD;
app.use(session({
  store: new SqliteSessionStore(db),
  secret: process.env.SESSION_SECRET || 'cambia-esto-urgente-min-32-chars!!',
  resave: false,
  saveUninitialized: false,
  rolling: true,       // cada actividad renueva las 2 h: no te saca a media sesión
  cookie: {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',    // 'lax' permite navegación normal desde el sitio principal
    maxAge: 2 * 60 * 60 * 1000  // 2 horas
  }
}));

// ─── Archivos estáticos (solo la carpeta public/) ─────────────────────────────
// uploads/ y data/ NO se exponen como estáticos
app.use(express.static(path.join(__dirname, 'public')));

// ─── Ruta raíz: redirigir al login ───────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/login'));

// ─── Rate limiter solo en POST de login (no en GET de página) ────────────────
app.post('/login',       loginLimiter);
app.post('/admin/login', loginLimiter);

// ─── Rutas principales ────────────────────────────────────────────────────────
app.use('/admin',     adminRoutes);
app.use('/',          authRoutes);
app.use('/dashboard', dashboardRoutes);

// ─── Página de error para ataques ────────────────────────────────────────────
app.get('/error-ataque.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'error-ataque.html'));
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).redirect('/login'));

// ─── Error handler global ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ─── Arrancar ─────────────────────────────────────────────────────────────────
// Render/Heroku: escucha en 0.0.0.0 (todas las interfaces) en el puerto $PORT.
// Local (Windows): escucha en 127.0.0.1:3500 por defecto.
const HOST = process.env.HOST || (IS_PROD ? '0.0.0.0' : '127.0.0.1');
app.listen(PORT, HOST, () => {
  console.log(`\n================================================`);
  console.log(` IVA - Grupo GDM corriendo en http://${HOST}:${PORT}`);
  console.log(`================================================\n`);
  iniciarScheduler();
});

module.exports = app;
