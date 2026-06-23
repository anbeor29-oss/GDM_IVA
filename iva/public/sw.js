'use strict';

/**
 * Service Worker — GDM IVA
 *
 * Estrategia:
 *  - Activos estáticos (CSS, JS, iconos): Cache First (rápido + offline)
 *  - HTML del login: Network First, fallback a cache (siempre fresco si hay red)
 *  - Páginas autenticadas (/dashboard, /admin): Network Only (NUNCA cachear datos del cliente)
 *  - API (/dashboard/api/*): Network Only (NUNCA cachear)
 *
 * Versión del cache se actualiza en cada release para forzar refresh.
 */

const CACHE_VERSION = 'gdm-iva-v1.0.0';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Archivos pre-cacheados al instalar el SW (app shell)
const PRECACHE_ASSETS = [
  '/login',
  '/offline.html',
  '/css/styles.css',
  '/js/antiCapture.js',
  '/js/pwa-register.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Rutas que NUNCA se cachean (datos sensibles o dinámicos)
const NEVER_CACHE_PATTERNS = [
  /\/dashboard\/api\//,
  /\/admin\//,
  /\/dashboard$/,
  /\/logout/
];

// ── Install: precachear el app shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] Precache fallo:', err))
  );
});

// ── Activate: limpiar caches viejos ──────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: estrategia por tipo de recurso ────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (NEVER_CACHE_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    event.respondWith(fetch(request).catch(() => offlineFallback(request)));
    return;
  }

  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || offlineFallback(request);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    return offlineFallback(request);
  }
}

async function offlineFallback(request) {
  if (request.headers.get('accept')?.includes('text/html')) {
    return caches.match('/offline.html');
  }
  return new Response('Sin conexión', {
    status: 503,
    statusText: 'Service Unavailable'
  });
}

// ── Web Push (fase 2 - inactivo por ahora) ───────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'Tu descarga del SAT ha terminado.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      vibrate: [200, 100, 200],
      data: { url: data.url || '/dashboard' }
    };
    event.waitUntil(
      self.registration.showNotification(data.title || 'IVA GDM', options)
    );
  } catch (e) { /* no-op */ }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data?.url || '/dashboard')
  );
});
