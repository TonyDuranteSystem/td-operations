// Portal Service Worker — handles push notifications
self.addEventListener('push', function (event) {
  if (!event.data) return

  const data = event.data.json()

  const options = {
    body: data.body || '',
    icon: '/portal-icons/icon-192.png',
    badge: '/portal-icons/icon-192.png',
    tag: data.tag || 'portal-notification',
    data: {
      url: data.url || '/portal',
    },
    vibrate: [200, 100, 200],
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'TD Portal', options)
  )
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()

  const url = event.notification.data?.url || '/portal'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      // Focus existing window if open
      for (const client of windowClients) {
        if (client.url.includes('/portal') && 'focus' in client) {
          return client.focus()
        }
      }
      // Open new window
      return clients.openWindow(url)
    })
  )
})
