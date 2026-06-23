'use strict';

/**
 * Registro del Service Worker + prompt de instalación.
 * Se carga en login.html, dashboard.html, etc.
 */

(function () {
  // 1. Registrar Service Worker (solo si el navegador lo soporta)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => {
          console.log('[PWA] Service Worker registrado:', reg.scope);

          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker?.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA] Nueva version disponible.');
              }
            });
          });
        })
        .catch((err) => console.warn('[PWA] Fallo registro SW:', err));
    });
  }

  // 2. Capturar evento `beforeinstallprompt` para nuestro CTA
  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    mostrarBotonInstalar();
  });

  function mostrarBotonInstalar() {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (document.getElementById('pwa-install-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'pwa-install-btn';
    btn.textContent = '📲 Instalar app';
    btn.setAttribute('aria-label', 'Instalar aplicacion en el dispositivo');
    btn.style.cssText = [
      'position: fixed',
      'bottom: 20px',
      'right: 20px',
      'z-index: 9999',
      'background: #1e3a8a',
      'color: #fff',
      'border: 2px solid #fbbf24',
      'border-radius: 50px',
      'padding: 12px 22px',
      'font-weight: 700',
      'font-size: 0.95rem',
      'cursor: pointer',
      'box-shadow: 0 10px 25px -5px rgba(30, 58, 138, 0.5)',
      'font-family: inherit',
      'animation: pwa-pulse 2.5s ease-in-out infinite'
    ].join(';');
    btn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      console.log('[PWA] Decision del usuario:', outcome);
      deferredInstallPrompt = null;
      btn.remove();
    });
    document.body.appendChild(btn);
  }

  // 3. Confirmar instalación
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] App instalada exitosamente.');
    document.getElementById('pwa-install-btn')?.remove();
  });

  // 4. Detectar modo standalone
  if (window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true) {
    document.documentElement.classList.add('pwa-installed');
  }
})();
