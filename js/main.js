/* ═══════════════════════════════════════════════════
   GDM HIGH CONSULTING MÉXICO — main.js
   Versión: 1.0.0 | Mayo 2026
═══════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', function () {

  /* ──────────────────────────────────────────
     1. FORMULARIO DE CONTACTO — Formsubmit AJAX
     Envía a info@hcgm.com.mx sin recargar página
  ────────────────────────────────────────── */
  const form    = document.getElementById('contacto-form');
  const btnSend = document.getElementById('form-submit-btn');
  const divOk   = document.getElementById('form-success');
  const divErr  = document.getElementById('form-error');

  if (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();

      btnSend.textContent = 'Enviando…';
      btnSend.disabled    = true;
      divOk.style.display = 'none';
      divErr.style.display = 'none';

      try {
        const data = new FormData(form);
        const res  = await fetch('https://formsubmit.co/ajax/info@hcgm.com.mx', {
          method:  'POST',
          headers: { 'Accept': 'application/json' },
          body:    data
        });
        const json = await res.json();

        if (json.success === 'true' || json.success === true) {
          divOk.style.display = 'block';
          form.reset();
          // Scroll suave al mensaje de éxito
          divOk.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          divErr.style.display = 'block';
        }
      } catch (err) {
        divErr.style.display = 'block';
      } finally {
        btnSend.textContent = 'Enviar solicitud →';
        btnSend.disabled    = false;
      }
    });
  }

  /* ──────────────────────────────────────────
     2. NAVBAR — marcar sección activa al hacer scroll
  ────────────────────────────────────────── */
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-links a');

  function updateActiveNav() {
    let current = '';
    sections.forEach(function (s) {
      if (window.scrollY >= s.offsetTop - 90) {
        current = s.id;
      }
    });
    navLinks.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current);
    });
  }

  window.addEventListener('scroll', updateActiveNav, { passive: true });
  updateActiveNav();

  /* ──────────────────────────────────────────
     3. NAVBAR — sombra al hacer scroll
  ────────────────────────────────────────── */
  const navEl = document.querySelector('nav');
  window.addEventListener('scroll', function () {
    if (window.scrollY > 10) {
      navEl.style.boxShadow = '0 4px 32px rgba(9,27,78,.15)';
    } else {
      navEl.style.boxShadow = '0 2px 20px rgba(9,27,78,.08)';
    }
  }, { passive: true });

  /* ──────────────────────────────────────────
     4. ANIMACIÓN AL ENTRAR EN VISTA (Intersection Observer)
     Las tarjetas y secciones aparecen con fade-in
  ────────────────────────────────────────── */
  const animEls = document.querySelectorAll('.svc-card, .feature-item, .contact-card, .stat-num');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.style.opacity    = '1';
          entry.target.style.transform  = 'translateY(0)';
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    animEls.forEach(function (el) {
      el.style.opacity   = '0';
      el.style.transform = 'translateY(24px)';
      el.style.transition = 'opacity .5s ease, transform .5s ease';
      observer.observe(el);
    });
  }

  /* ──────────────────────────────────────────
     5. CONTADOR ANIMADO en estadísticas del hero
  ────────────────────────────────────────── */
  function animateCount(el, target, suffix) {
    let start   = 0;
    const dur   = 1800;
    const step  = 16;
    const inc   = target / (dur / step);

    const timer = setInterval(function () {
      start += inc;
      if (start >= target) {
        el.textContent = (suffix === '%') ? target + suffix : '+' + target;
        clearInterval(timer);
      } else {
        el.textContent = Math.floor(start) + (suffix || '');
      }
    }, step);
  }

  // Activar cuando el hero es visible
  const statsEls = document.querySelectorAll('.stat-num');
  if (statsEls.length && 'IntersectionObserver' in window) {
    const statsObs = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        const targets = [5, 10, 100];
        const suffixes = ['', '', '%'];
        statsEls.forEach(function (el, i) {
          animateCount(el, targets[i], suffixes[i]);
        });
        statsObs.disconnect();
      }
    }, { threshold: 0.5 });
    if (statsEls[0]) statsObs.observe(statsEls[0].closest('.hero-stats') || statsEls[0]);
  }

});
