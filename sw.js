const CACHE_NAME = 'macromix-pwa-v8.6';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/firebase-db.js',
  '/simplewebauthn-browser.min.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/logo.png',
  '/icons/logo-full.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('[SW] Precache partial error:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API or Cloud Function calls
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth') ||
    url.pathname === '/geminiProxy' ||
    url.pathname === '/getLeaderboard' ||
    url.hostname.includes('generativelanguage.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com')
  ) {
    return;
  }

  // Network-first with 3-second timeout fallback to cache for shell assets (H10, H11)
  if (event.request.method === 'GET') {
    event.respondWith(
      new Promise((resolve, reject) => {
        let hasResolved = false;
        const timeoutId = setTimeout(() => {
          if (!hasResolved) {
            caches.match(event.request, { ignoreSearch: true }).then((cached) => {
              if (cached) {
                hasResolved = true;
                resolve(cached);
              }
            });
          }
        }, 3000);

        fetch(event.request)
          .then((response) => {
            if (!hasResolved) {
              hasResolved = true;
              clearTimeout(timeoutId);
              if (response && response.status === 200 && response.type === 'basic') {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
              }
              resolve(response);
            }
          })
          .catch(() => {
            if (!hasResolved) {
              hasResolved = true;
              clearTimeout(timeoutId);
              caches.match(event.request, { ignoreSearch: true })
                .then(cached => cached || caches.match('/index.html', { ignoreSearch: true }))
                .then(resolve)
                .catch(reject);
            }
          });
      })
    );
  }
});

// --- Push Notification & Background Reminder Handlers ---

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Macromix Daily Reminder 🎯';
  const options = {
    body: data.body || "Don't forget to track your macros today!",
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [150, 50, 150],
    data: {
      url: data.url || '/'
    },
    tag: 'macromix-daily-reminder',
    renotify: true,
    actions: [
      { action: 'open', title: 'Open Macromix ⚡' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const title = event.data.title || 'Macromix Reminder 🎯';
    const options = {
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [150, 50, 150],
      tag: 'macromix-daily-reminder',
      renotify: true,
      ...event.data.options
    };
    event.waitUntil(self.registration.showNotification(title, options));
  }
});
