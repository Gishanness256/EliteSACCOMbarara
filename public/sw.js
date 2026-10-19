/* Elite SACCO service worker
 *
 * Strategy
 *  - App shell (index.html, offline page, manifest, icons, local css/js) is precached into a
 *    cache named after VERSION. Everything in it is served cache-first, so a release is atomic:
 *    users see the old version or the new version, never a mix.
 *  - A new version installs in the background and WAITS. The page shows an "Update now" prompt
 *    (see pwa-register.js); clicking it sends SKIP_WAITING and the page reloads on the new version.
 *  - CDN libraries (cdnjs) and Google Fonts are cached at runtime and also precached when online,
 *    so the app starts offline. Those URLs are version-pinned, so their cache outlives releases.
 *  - Requests to other origins (a database or API) and non-GET requests are never touched.
 *
 * To release: change VERSION below (and add any new files to the lists), then deploy.
 * sw.js must sit at the root of the published site so it controls every page.
 */
'use strict';

const VERSION = '1.0.0';
const PREFIX = 'elite-sacco';
const SHELL_CACHE = `${PREFIX}-shell-v${VERSION}`;
const CDN_CACHE = `${PREFIX}-cdn-r1`;   // change r1 -> r2 when you change a library version below
const FONT_CACHE = `${PREFIX}-fonts-r1`;
const KEEP = new Set([SHELL_CACHE, CDN_CACHE, FONT_CACHE]);

const SCOPE = self.registration.scope;               // e.g. https://user.github.io/elite-sacco/
const abs = (p) => new URL(p, SCOPE).href;
const INDEX = abs('index.html');
const OFFLINE = abs('offline.html');

/* Must all download or the install fails and is retried later. */
const CORE = ['index.html'];

/* Downloaded if present. A missing file (an icon you have not added yet) does not break install. */
const OPTIONAL = [
  'offline.html',
  'manifest.webmanifest',
  'favicon.ico',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon-180.png',
  'icons/logo.png',
  'css/styles.css',
  'js/app.js', 'js/auth.js', 'js/db.js', 'js/api.js', 'js/sync.js',
  'js/members.js', 'js/savings.js', 'js/loans.js',
  'js/statements.js', 'js/regulatory.js', 'js/audit.js', 'js/export.js',
  'pwa-register.js'
];

/* Libraries and fonts the app loads from the web. Keep in step with index.html. */
const CDN_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap'
];

/* Same-origin paths that must always go to the network (a future API on the same domain). */
const NETWORK_ONLY = /\/(api|auth|rest|functions|rpc)\//;

/* ---------- helpers ---------- */

const cacheable = (res) =>
  !!res && res.status !== 206 && (res.ok || res.type === 'opaque');

async function precache(cache, url) {
  // cache:'reload' skips the browser HTTP cache, so a host that sends max-age
  // (GitHub Pages sends 10 minutes) cannot put stale files into the new version.
  const res = await fetch(new Request(abs(url), { cache: 'reload' }));
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  await cache.put(abs(url), res);
}

async function precacheRemote(cache, url) {
  if (await cache.match(url)) return;
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  await cache.put(url, res);
}

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  try {
    const res = await fetch(event.request);
    if (cacheable(res)) event.waitUntil(cache.put(event.request, res.clone()));
    return res;
  } catch (err) {
    return Response.error();
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then((res) => {
      if (cacheable(res)) cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) || Response.error();
}

async function navigate(event) {
  const shell = await caches.open(SHELL_CACHE);
  // One-page app: every page request in scope gets index.html from the current version.
  const page = await shell.match(INDEX);
  if (page) return page;
  try {
    return await fetch(event.request);
  } catch (err) {
    const off = await shell.match(OFFLINE);
    return off || new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Offline</title><body style="font:16px system-ui;padding:2rem;max-width:30rem;margin:auto">' +
      '<h1>You are offline</h1><p>Elite SACCO could not load. Check your connection and try again.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* ---------- lifecycle ---------- */

self.addEventListener('install', (event) => {
  // No skipWaiting() here on purpose: the new version waits until the user taps "Update now".
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await Promise.all(CORE.map((u) => precache(shell, u)));
    await Promise.allSettled(OPTIONAL.map((u) => precache(shell, u)));
    const cdn = await caches.open(CDN_CACHE);
    const fonts = await caches.open(FONT_CACHE);
    await Promise.allSettled(CDN_PRECACHE.map((u) =>
      precacheRemote(u.includes('fonts.googleapis.com') ? fonts : cdn, u)));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith(`${PREFIX}-`) && !KEEP.has(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
    const open = await self.clients.matchAll({ type: 'window' });
    open.forEach((c) => c.postMessage({ type: 'SW_ACTIVATED', version: VERSION }));
  })());
});

/* ---------- requests ---------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    if (url.href === abs('sw.js') || NETWORK_ONLY.test(url.pathname)) return;
    if (req.mode === 'navigate') {
      event.respondWith(navigate(event));
      return;
    }
    event.respondWith(cacheFirst(event, SHELL_CACHE));
    return;
  }

  switch (url.hostname) {
    case 'cdnjs.cloudflare.com':
      event.respondWith(cacheFirst(event, CDN_CACHE));
      break;
    case 'fonts.googleapis.com':
      event.respondWith(staleWhileRevalidate(event, FONT_CACHE));
      break;
    case 'fonts.gstatic.com':
      event.respondWith(cacheFirst(event, FONT_CACHE));
      break;
    default:
      // Any other origin (database, API) goes straight to the network.
  }
});

/* ---------- messages from the page ---------- */

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const reply = (data) => event.ports && event.ports[0] && event.ports[0].postMessage(data);
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (msg.type === 'GET_VERSION') {
    reply({ version: VERSION });
  } else if (msg.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys()
        .then((names) => Promise.all(names.filter((n) => n.startsWith(`${PREFIX}-`)).map((n) => caches.delete(n))))
        .then(() => reply({ cleared: true }))
    );
  }
});
