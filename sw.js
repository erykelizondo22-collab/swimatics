const CACHE_NAME = 'swimops-v43';
const urlsToCache = [
  './index.html',
  './manifest.json',
  './icon.png'
];

// Install the service worker and cache the core files.
// Each file is cached individually (not with cache.addAll) so that if
// any single one fails to fetch, it doesn't take the whole install
// down with it -- addAll() is all-or-nothing, which is how a single
// wrong filename can silently break offline support entirely.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.all(
        urlsToCache.map(url =>
          cache.add(url).catch(err => console.warn('Failed to cache', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Intercept network requests and serve from cache if available.
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      // Return the cached version if found.
      if (response) {
        return response;
      }
      // Otherwise, fetch from the network.
      return fetch(event.request);
    })
  );
});

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { title: 'Swimatics', body: event.data ? event.data.text() : 'You have a new notification.' };
    }

    const title = payload.title || 'Swimatics';
    const options = {
        body: payload.body || '',
        icon: payload.icon || 'icon.png',
        badge: payload.badge || 'icon.png',
        data: payload.url || '/',
        tag: payload.tag || undefined
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a notification focuses an existing Swimatics tab if one is
// open, or opens a new one to the relevant page.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});
