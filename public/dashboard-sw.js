// Dashboard Service Worker — PWA installability, push handling, offline fallback
// Bump CACHE_NAME whenever the precached assets change.
var CACHE_NAME = 'td-dashboard-v1'
var OFFLINE_URL = '/offline'

self.addEventListener('install', function (event) {
  // Don't call skipWaiting — wait for client SKIP_WAITING message
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.add(OFFLINE_URL)
    })
  )
})

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME })
          .map(function (key) { return caches.delete(key) })
      )
    }).then(function () {
      return self.clients.claim()
    })
  )
})

// Offline fallback for page navigations ONLY. Data is never cached — a live
// CRM must not show stale financials. Network-first; the cached /offline page
// is served only when the network itself fails.
self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(OFFLINE_URL).then(function (cached) {
        return cached || Response.error()
      })
    })
  )
})

// Push notifications
self.addEventListener('push', function (event) {
  if (!event.data) return

  var data = event.data.json()

  var options = {
    body: data.body || '',
    icon: '/portal-icons/icon-192.png',
    badge: '/portal-icons/icon-192.png',
    tag: data.tag || 'admin-notification',
    requireInteraction: true,
    data: {
      url: data.url || '/portal-chats',
    },
    vibrate: [200, 100, 200],
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'TD Operations', options)
  )
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()

  var url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/portal-chats'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i]
        if (client.url.indexOf('/portal-chats') !== -1 && 'focus' in client) {
          return client.focus()
        }
      }
      return clients.openWindow(url)
    })
  )
})
