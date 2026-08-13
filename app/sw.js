const CACHE_NAME = 'swimops-v78';
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

// The main app document (navigations, and index.html directly) uses
// network-first: always fetch the latest version when online, and
// only fall back to whatever's cached if the network request fails
// (offline). This is what actually lets a new deploy reach users
// without bumping CACHE_NAME -- the old cache-first-for-everything
// approach below is why every previous update needed a version bump
// just to get the new HTML past this service worker.
const isAppDocument = (request) =>
  request.mode === 'navigate' || request.url.endsWith('/index.html') || request.url.endsWith('/');

self.addEventListener('fetch', event => {
  // Only GET requests are safe to intercept/cache -- a POST (like the
  // Stripe checkout call) has a body, and running it through
  // caches.match()/fetch() the way GET requests are handled below
  // breaks it. Letting the browser handle non-GET requests itself
  // (by simply not calling respondWith) is the documented, correct
  // pattern for this.
  if (event.request.method !== 'GET') {
    return;
  }

  if (isAppDocument(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (manifest, icons) changes rarely, so cache-first
  // stays faster and still works offline.
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) {
        return response;
      }
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
