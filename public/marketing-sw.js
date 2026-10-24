// TD Marketing Service Worker — push notifications + offline fallback. NO CACHING.
//
// The marketing team's chat (dev job 9aec66fa, Addendum G) sends a notification when somebody writes about a lead. This worker is separate from the CRM's, the portal's and TD Talk's
// and has a strictly narrower scope (/marketing). Rules (docs/systems/pwa.md, enforced by tests/unit/service-worker-no-page-cache.test.ts):
//  - It stores NOTHING in Cache Storage. Its offline fallback is a self-contained Response built here.
//  - It never touches a window that is not a /marketing window.
//  - A tapped notification can only ever go to an address under /marketing: marketingUrlFor() sends anything else (another page, another site) to plain /marketing/board.
var SW_VERSION = 'td-marketing-20261023-1'
var BASE = '/marketing'

self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()) })

function isMarketingPath(p) { return p === BASE || p.indexOf(BASE + '/') === 0 }

function marketingUrlFor(raw) {
  try {
    var u = new URL(String(raw == null ? '' : raw), self.location.origin)
    if (u.origin !== self.location.origin) return BASE + '/board'
    if (isMarketingPath(u.pathname)) return u.pathname + u.search + u.hash
    return BASE + '/board'
  } catch (e) {
    return BASE + '/board'
  }
}

// Offline fallback for page navigations ONLY — nothing cached, so this is an inline response.
self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>TD Marketing</title></head>' +
        '<body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff">' +
        '<div style="text-align:center;padding:24px">' +
        '<h1 style="font-size:22px;margin:0 0 12px">TD Marketing</h1>' +
        '<p style="color:#6b7280;margin:0 0 4px">You are offline. Please check your connection.</p>' +
        '<button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#111827;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer">Retry</button>' +
        '</div></body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )
    })
  )
})

// Delivery receipt: a chat push that reaches this device means the message has been RECEIVED — tell the server so the sender's tick turns grey-double.
// Needs only the lead id from the notification address (?chat=<lead id>). Best effort, never blocks the notification.
function ackDelivered(data) {
  try {
    var m = /[?&]chat=([0-9a-fA-F-]{36})/.exec(String((data && data.url) || ''))
    if (!m) return Promise.resolve()
    return fetch('/api/marketing/chat/delivered', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ lead_id: m[1] }] }),
    }).catch(function () {})
  } catch (e) { return Promise.resolve() }
}

// Push. A notification is ALWAYS shown (iOS drops a subscription that receives pushes it does not display).
self.addEventListener('push', function (event) {
  if (!event.data) return
  var data = event.data.json()
  var options = {
    body: data.body || '',
    tag: data.tag || 'marketing-notification',
    data: { url: marketingUrlFor(data.url) },
    vibrate: [200, 100, 200],
  }
  event.waitUntil(Promise.all([self.registration.showNotification(data.title || 'TD Marketing', options), ackDelivered(data)]))
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var target = marketingUrlFor(event.notification.data && event.notification.data.url)
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      var mine = windowClients.filter(function (c) {
        try { return 'focus' in c && isMarketingPath(new URL(c.url).pathname) } catch (e) { return false }
      })
      var client = mine.filter(function (c) { return c.frameType === 'top-level' })[0] || mine[0]
      if (!client) return clients.openWindow(target)
      // Ask the open page to go there itself (nothing typed is lost); if it never answers, navigate it.
      return new Promise(function (resolve) {
        var settled = false
        function fallback() {
          if (settled) return
          settled = true
          if ('navigate' in client) {
            client.navigate(target).then(function (c) { resolve((c || client).focus()) }, function () { resolve(client.focus()) })
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
          client.postMessage({ type: 'td-navigate', url: target }, [channel.port2])
        } catch (e) {
          clearTimeout(timer)
          fallback()
        }
      })
    })
  )
})
