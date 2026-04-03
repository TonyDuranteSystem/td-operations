// Dashboard Service Worker — minimal SW for PWA installability + push handling
self.addEventListener('install', function () {
  // Don't call skipWaiting — wait for client SKIP_WAITING message
})

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('activate', function () {
  self.clients.claim()
})

// Push notifications (same as admin-sw.js — handles notifications if registered here)
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
