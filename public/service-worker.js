/**
 * Offline app-shell caching for Chess Clock Timer.
 *
 * The timer's core logic (timerEngine.js) never touches the network, so the
 * only thing offline support needs to guarantee is that the HTML/CSS/JS
 * shell itself is available without a connection after the first load.
 * Firebase (only used for optional history sync) is intentionally NOT
 * precached or proxied here — if a fetch to Firebase fails offline, that
 * failure is handled by firebaseHistory.js itself (best-effort, timeout
 * guarded) and must never affect the app shell.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `chess-clock-timer-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/timerEngine.js',
  './js/storage.js',
  './js/feedback.js',
  './js/wakeLock.js',
  './js/firebaseHistory.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never intercept cross-origin requests (Firebase SDK/Firestore calls) —
  // those must go straight to the network (or fail cleanly offline) and are
  // handled defensively by firebaseHistory.js itself.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Offline and not cached: fall back to the app shell for
          // navigation requests so a direct reload while offline still works.
          if (request.mode === 'navigate') return caches.match('./index.html');
          return undefined;
        });
    }),
  );
});
