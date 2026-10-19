/* Registers sw.js and shows an "Update now" prompt when a new version is waiting.
 * Load it at the end of index.html:  <script src="pwa-register.js"></script>
 * sw.js and this file are separate: the worker cannot show anything on screen by itself. */
(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  const ok = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!ok) return;

  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  // Reload once when the new worker takes over. The very first install also fires this
  // event (no earlier worker), and that must not reload the page.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  function showPrompt(worker) {
    if (document.getElementById('sw-update')) return;
    const bar = document.createElement('div');
    bar.id = 'sw-update';
    bar.setAttribute('role', 'status');
    bar.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;justify-content:center;' +
      'bottom:calc(1rem + env(safe-area-inset-bottom,0px));max-width:calc(100% - 2rem);padding:.7rem 1rem;border-radius:12px;' +
      'background:var(--blue,#1B3C91);color:#fff;font:600 .9rem Manrope,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.3)';
    const text = document.createElement('span');
    text.textContent = 'A new version of Elite SACCO is ready.';
    const mk = (label, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'font:inherit;cursor:pointer;border-radius:8px;padding:.4rem .9rem;border:1.5px solid #fff;' +
        (primary ? 'background:#fff;color:#1B3C91' : 'background:transparent;color:#fff');
      return b;
    };
    const go = mk('Update now', true), later = mk('Later', false);
    go.onclick = () => { go.disabled = true; go.textContent = 'Updating…'; worker.postMessage({ type: 'SKIP_WAITING' }); };
    later.onclick = () => bar.remove();
    bar.append(text, go, later);
    document.body.appendChild(bar);
  }

  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' makes the browser fetch sw.js fresh every time, even on hosts
      // that cannot send Cache-Control: no-cache (GitHub Pages).
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });

      // A worker already waiting from an earlier visit.
      if (reg.waiting && navigator.serviceWorker.controller) showPrompt(reg.waiting);

      // A worker that installs while the page is open.
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) showPrompt(next);
        });
      });

      // Look for a new version on return to the tab and once an hour.
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      setInterval(check, 60 * 60 * 1000);
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  });
})();
