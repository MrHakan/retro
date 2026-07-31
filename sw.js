/**
 * RETRO-CANVAS-ARCADE — service worker.
 *
 * Goal: after one visit the entire arcade runs forever with no network at all
 * (the "shipboard" case — satellite drops, airplane mode, a dead uplink).
 *
 * Every path below is relative to this file's own location, so the same
 * worker functions unchanged at `https://user.github.io/` and at
 * `https://user.github.io/repository-name/`. Nothing here assumes a host,
 * a port, or a root-anchored path.
 */

const VERSION = 'rca-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

/**
 * The full offline payload. Because the game registry imports all 22 cabinets
 * statically, precaching this list means every game is playable offline after
 * the first load — no per-game "download" step, no surprises mid-flight.
 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/arcade.css',

  './js/main.js',
  './js/core/audio.js',
  './js/core/display.js',
  './js/core/engine.js',
  './js/core/fx.js',
  './js/core/input.js',
  './js/core/storage.js',
  './js/core/ui.js',

  './js/games/index.js',
  './js/games/snake.js',
  './js/games/tetris.js',
  './js/games/invaders.js',
  './js/games/roguelike.js',
  './js/games/towerdefense.js',
  './js/games/runner.js',
  './js/games/breakout.js',
  './js/games/zombies.js',
  './js/games/rhythm.js',
  './js/games/chess.js',
  './js/games/asteroids.js',
  './js/games/minigolf.js',
  './js/games/racer.js',
  './js/games/lander.js',
  './js/games/vectorwar.js',
  './js/games/missile.js',
  './js/games/crosser.js',
  './js/games/boulder.js',
  './js/games/gravityflip.js',
  './js/games/collapse.js',
  './js/games/pinball.js',
  './js/games/stealth.js',

  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/* ------------------------------------------------------------- install -- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Cache entries one at a time: `cache.addAll` is atomic, so a single 404
    // (say, a game module renamed in a future version) would abort the whole
    // install and leave the player with no offline copy at all.
    const results = await Promise.allSettled(
      PRECACHE.map(async (path) => {
        const url = new URL(path, self.registration.scope);
        const res = await fetch(url, { cache: 'reload' });
        if (!res.ok) throw new Error(`${res.status} ${path}`);
        await cache.put(url, res);
      })
    );
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? PRECACHE[i] : null))
      .filter(Boolean);
    if (failed.length) console.warn('[sw] precache misses:', failed);
  })());
  // A fresh arcade should take over immediately rather than waiting for every
  // tab to close — there is no server state to keep in sync.
  self.skipWaiting();
});

/* ------------------------------------------------------------ activate -- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

/* --------------------------------------------------------------- fetch -- */

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never touch cross-origin traffic; the arcade makes none, but an extension
  // or a devtools request shouldn't be intercepted.
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so a deployed update lands promptly, with the
  // cached shell as the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) {
          putRuntime(req, preload.clone());
          return preload;
        }
        const net = await fetch(req);
        putRuntime(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (
          (await cache.match(new URL('./index.html', self.registration.scope))) ||
          (await cache.match(new URL('./', self.registration.scope))) ||
          new Response('<h1>Offline</h1><p>The arcade has not been cached yet.</p>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            status: 503,
          })
        );
      }
    })());
    return;
  }

  // Everything else: cache-first (instant, works offline) with a quiet
  // background refresh so the next load picks up any deployed change.
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(revalidate(req));
      return cached;
    }
    try {
      const net = await fetch(req);
      if (net.ok) putRuntime(req, net.clone());
      return net;
    } catch {
      return new Response('', { status: 504, statusText: 'Offline and uncached' });
    }
  })());
});

async function revalidate(req) {
  try {
    const net = await fetch(req, { cache: 'no-cache' });
    if (net.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(req, net);
    }
  } catch {
    /* Offline: keeping the cached copy is exactly the right outcome. */
  }
}

async function putRuntime(req, res) {
  if (!res || !res.ok) return;
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(req, res);
  } catch {
    /* Quota or opaque response — not fatal. */
  }
}

/* ------------------------------------------------------------ messages -- */

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data?.type === 'CACHE_STATUS') {
    event.waitUntil((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const keys = await cache.keys();
      event.source?.postMessage({ type: 'CACHE_STATUS', cached: keys.length, expected: PRECACHE.length });
    })());
  }
});
