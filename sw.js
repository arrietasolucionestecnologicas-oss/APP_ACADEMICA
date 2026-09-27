// Se retira el Service Worker por completo: en varias pruebas terminó sirviendo
// una mezcla de HTML/JS de distintas versiones y rompiendo la app por completo.
// Este script corre una única vez para limpiar cualquier caché viejo, se
// desregistra a sí mismo, y de aquí en adelante el navegador maneja todo con
// peticiones normales (más simple y confiable). app.js ya no vuelve a registrar
// un Service Worker nuevo tras esta limpieza.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
            .then(() => self.registration.unregister())
            .then(() => self.clients.matchAll({ type: 'window' }))
            .then((clients) => clients.forEach((client) => client.navigate(client.url)))
    );
});
