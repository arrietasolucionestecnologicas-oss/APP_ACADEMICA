const CACHE_VERSION = 'apuntes-v1';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

// Archivos propios del proyecto: se sirven "red primero" para que un cambio nuevo
// se vea de inmediato; el caché es solo el respaldo cuando no hay conexión.
const APP_FILES = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

// Librerías externas: cambian poco, se sirven de caché al instante y se refrescan detrás.
const CDN_FILES = [
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) =>
            Promise.allSettled(APP_FILES.concat(CDN_FILES).map((url) => cache.add(url).catch(() => {})))
        ).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

function isApiCall(url) { return url.hostname === 'script.google.com'; }
function isImageHost(url) { return url.hostname === 'lh3.googleusercontent.com'; }
function isAppFile(url) { return url.origin === self.location.origin; }

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // No cachear POST (llamadas a la API)

    const url = new URL(req.url);
    if (isApiCall(url)) return; // Datos dinámicos: siempre red directa

    if (isImageHost(url)) {
        // Fotos del cuaderno: cache-first para verlas sin conexión, refrescando en segundo plano.
        event.respondWith(
            caches.open(RUNTIME_CACHE).then(async (cache) => {
                const cached = await cache.match(req);
                const networkFetch = fetch(req).then((res) => {
                    if (res && res.ok) cache.put(req, res.clone());
                    return res;
                }).catch(() => cached);
                return cached || networkFetch;
            })
        );
        return;
    }

    if (isAppFile(url)) {
        // HTML/JS/manifest propios: red primero (siempre lo más nuevo), caché solo si no hay conexión.
        event.respondWith(
            fetch(req).then((res) => {
                if (res && res.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
                return res;
            }).catch(() => caches.match(req))
        );
        return;
    }

    // Librerías CDN: cache-first con actualización en segundo plano.
    event.respondWith(
        caches.match(req).then((cached) => {
            const networkFetch = fetch(req).then((res) => {
                if (res && res.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
                return res;
            }).catch(() => cached);
            return cached || networkFetch;
        })
    );
});
