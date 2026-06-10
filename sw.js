// ===== BRITON SCIENCE — Service Worker PWA =====
const CACHE_NAME = 'briton-science-v1';
const OFFLINE_URL = '/index.html';

// Fichiers à mettre en cache pour le mode hors-ligne
const ASSETS_TO_CACHE = [
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// ===== INSTALLATION =====
self.addEventListener('install', event => {
  console.log('[SW] Installation…');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Mise en cache des fichiers statiques');
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.log('[SW] Certains fichiers non mis en cache (normal en dev):', err);
      });
    })
  );
  self.skipWaiting();
});

// ===== ACTIVATION =====
self.addEventListener('activate', event => {
  console.log('[SW] Activation…');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Suppression ancien cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

// ===== FETCH (stratégie: Network First, Cache Fallback) =====
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ne pas intercepter les appels API Anthropic (toujours en ligne)
  if (url.hostname === 'api.anthropic.com') {
    return;
  }

  // Ne pas intercepter les appels Google Fonts
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('gstatic.com')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        // Mettre en cache les réponses réussies
        if (response && response.status === 200 && request.method === 'GET') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback: retourner depuis le cache
        return caches.match(request).then(cached => {
          if (cached) return cached;
          // Fallback final: page principale
          return caches.match(OFFLINE_URL);
        });
      })
  );
});

// ===== NOTIFICATIONS PUSH (optionnel pour plus tard) =====
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const title = data.title || 'Briton Science';
  const options = {
    body: data.body || 'Nouvelle notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
