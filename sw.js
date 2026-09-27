const CACHE_VERSION = 'iubvault-v3';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

const PRECACHE_URLS = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdn-icons-png.flaticon.com/512/3233/3233036.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) =>
            Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {})))
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

function isApiCall(url) {
    return url.hostname === 'script.google.com';
}

function isImageHost(url) {
    return url.hostname === 'lh3.googleusercontent.com';
}

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

    // Shell de la app y librerías CDN: cache-first con actualización en segundo plano.
    event.respondWith(
        caches.match(req).then((cached) => {
            const networkFetch = fetch(req).then((res) => {
                if (res && res.ok) {
                    caches.open(SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
                }
                return res;
            }).catch(() => cached);
            return cached || networkFetch;
        })
    );
});
