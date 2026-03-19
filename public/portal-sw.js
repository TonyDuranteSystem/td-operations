// Portal Service Worker — push notifications + caching
const CACHE_NAME = 'td-portal-v1'

// Static assets to cache on install
const STATIC_ASSETS = [
  '/portal-icons/icon-192.png',
  '/portal-icons/icon-512.png',
]

// Install: pre-cache static assets
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(STATIC_ASSETS)
    })
  )
  self.skipWaiting()
})

// Activate: clean up old caches
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) { return name !== CACHE_NAME })
             .map(function (name) { return caches.delete(name) })
      )
    })
  )
  self.clients.claim()
})

// Fetch: network-first for API, cache-first for static assets
self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url)

  // Skip non-GET requests
  if (event.request.method !== 'GET') return

  // API routes: network-first (don't cache API responses)
  if (url.pathname.startsWith('/api/')) return

  // Next.js internal routes: skip
  if (url.pathname.startsWith('/_next/')) return

  // Portal pages and static assets: network-first with cache fallback
  if (url.pathname.startsWith('/portal') || STATIC_ASSETS.some(function(a) { return url.pathname === a })) {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          // Cache successful responses
          if (response.ok) {
            var responseClone = response.clone()
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, responseClone)
            })
          }
          return response
        })
        .catch(function () {
          // Network failed — try cache
          return caches.match(event.request).then(function (cached) {
            if (cached) return cached
            // Return offline fallback for navigation requests
            if (event.request.mode === 'navigate') {
              return new Response(
                '<html><body style="font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc">' +
                '<div style="text-align:center"><h1 style="color:#2563eb;font-size:24px">TD Portal</h1>' +
                '<p style="color:#6b7280">You are offline. Please check your connection.</p>' +
                '<button onclick="location.reload()" style="margin-top:16px;padding:10px 24px;background:#2563eb;color:white;border:none;border-radius:8px;cursor:pointer">Retry</button></div></body></html>',
                { headers: { 'Content-Type': 'text/html' } }
              )
            }
            return new Response('Offline', { status: 503 })
          })
        })
    )
  }
})

// Push notifications
self.addEventListener('push', function (event) {
  if (!event.data) return

  var data = event.data.json()

  var options = {
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

  var url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/portal'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i]
        if (client.url.indexOf('/portal') !== -1 && 'focus' in client) {
          return client.focus()
        }
      }
      return clients.openWindow(url)
    })
  )
})
