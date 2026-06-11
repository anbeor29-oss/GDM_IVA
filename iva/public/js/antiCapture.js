'use strict';
(function () {
  // Deshabilitar clic derecho
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Bloquear Ctrl+P, Ctrl+Shift+S, PrintScreen
  document.addEventListener('keydown', e => {
    if (e.key === 'PrintScreen') {
      e.preventDefault();
      oscurecer();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
    }
  });

  // Oscurecer pantalla cuando la ventana pierde foco (posible captura)
  let overlay = null;

  function crearOverlay() {
    overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:100vw', 'height:100vh',
      'background:#000', 'z-index:99999', 'display:none',
      'align-items:center', 'justify-content:center', 'color:#fff',
      'font-size:1.2rem', 'font-family:sans-serif'
    ].join(';');
    overlay.textContent = 'Contenido protegido';
    document.body.appendChild(overlay);
  }

  function oscurecer() {
    if (!overlay) crearOverlay();
    overlay.style.display = 'flex';
    setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 1500);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) oscurecer();
  });

  window.addEventListener('blur', oscurecer);

  // Inicializar overlay al cargar
  document.addEventListener('DOMContentLoaded', crearOverlay);
})();
