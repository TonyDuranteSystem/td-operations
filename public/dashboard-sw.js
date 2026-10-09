// Dashboard Service Worker — PWA installability, push handling, offline fallback
// Bump CACHE_NAME whenever the precached assets change.
var CACHE_NAME = 'td-dashboard-v2'
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
  // A page loaded INSIDE A FRAME (a floating window — dev job f3f3e237) goes straight
  // to the network, untouched. Re-requesting it from here (fetch(event.request)) makes
  // the browser drop its "this is a frame" label (Sec-Fetch-Dest becomes "empty"),
  // and the dashboard layout reads exactly that label to decide window mode. Found by
  // browser QA 2026-10-05: frames came back as the full CRM whenever this worker was
  // active. Only the offline fallback is skipped, which a floating window doesn't need.
  if (event.request.destination === 'iframe') return
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
      // Reuse an open app window and take it to the notification's actual target
      // (a team-chat notification must open Team Chat, not always /portal-chats).
      // Prefer the TOP-LEVEL page: a floating window is a frame, and navigating that would send the
      // wrong page to the target while the page the person is on stays put.
      // TD Talk (/talk) windows belong to /talk-sw.js and are never taken over here: both apps live on this
      // one site, and includeUncontrolled would otherwise hand us the TD Talk window (dev job c1e326dd).
      var focusable = windowClients.filter(function (c) {
        if (!('focus' in c)) return false
        try {
          var path = new URL(c.url).pathname
          return !(path === '/talk' || path.indexOf('/talk/') === 0)
        } catch (e) { return true }
      })
      var client = focusable.filter(function (c) { return c.frameType === 'top-level' })[0] || focusable[0]
      if (!client) return clients.openWindow(url)

      // Ask the page to go there itself (a client-side navigation): a full reload (client.navigate) would
      // reload every floating window and lose what was being typed in them. A page that is too old to
      // understand the message never answers, so after a short wait fall back to the full navigation.
      return new Promise(function (resolve) {
        var settled = false
        function fallback() {
          if (settled) return
          settled = true
          if ('navigate' in client) {
            client.navigate(url).then(function (c) { resolve((c || client).focus()) }, function () { resolve(client.focus()) })
          } else {
            resolve(client.focus())
          }
        }
        var timer = setTimeout(fallback, 700)
        try {
          var channel = new MessageChannel()
          channel.port1.onmessage = function () {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(client.focus())
          }
          client.postMessage({ type: 'td-navigate', url: url }, [channel.port2])
        } catch (e) {
          clearTimeout(timer)
          fallback()
        }
      })
    })
  )
})
