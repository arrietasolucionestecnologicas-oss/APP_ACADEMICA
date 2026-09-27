// Service Worker "interruptor de emergencia": borra cualquier caché viejo de una versión
// anterior, se desinstala a sí mismo y fuerza a recargar cada pestaña abierta con la
// versión real del servidor. Esto evita quedar atascado sirviendo una copia vieja.
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
