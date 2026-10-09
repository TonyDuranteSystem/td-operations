// TD Talk Service Worker — push notifications + offline fallback. NO CACHING.
//
// TD Talk is the standalone Team Chat app (dev job c1e326dd). It installs next to the CRM app from the SAME
// website, so this worker is deliberately separate from /dashboard-sw.js and has a strictly narrower scope
// (/talk), exactly like the portal worker (/portal-sw.js, scope /portal/).
//
// Rules (docs/systems/pwa.md, enforced by tests/unit/service-worker-no-page-cache.test.ts):
//  - It stores NOTHING in Cache Storage. Its offline fallback is a self-contained Response built here.
//  - It never touches a window that is not a TD Talk window, and the CRM worker never touches TD Talk's
//    (dashboard-sw.js skips /talk windows on a notification tap).
//
// Notification addresses: the server builds links for the CRM's own Team Chat page (/team-chat?thread=…).
// talkUrlFor() below turns those into the same query on /talk so a tap stays inside this app, and sends
// anything else (another page, another site) to plain /talk — a tap can never leave the app. The same rule
// lives in lib/talk/paths.ts::talkUrlFor and a unit test keeps the two in step.
var SW_VERSION = 'td-talk-20261009-2'
var TALK = '/talk'

self.addEventListener('install', function () {
  // Safe: nothing is cached, so there is no version skew to protect.
  self.skipWaiting()
})

// Kept for the update-banner flow (lib/hooks/use-sw-update.ts).
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim())
})

function isTalkPath(p) { return p === TALK || p.indexOf(TALK + '/') === 0 }
function isTeamChatPath(p) { return p === '/team-chat' || p.indexOf('/team-chat/') === 0 }

function talkUrlFor(raw) {
  try {
    var u = new URL(String(raw == null ? '' : raw), self.location.origin)
    if (u.origin !== self.location.origin) return TALK
    if (isTalkPath(u.pathname)) return u.pathname + u.search + u.hash
    if (isTeamChatPath(u.pathname)) return TALK + u.search + u.hash
    return TALK
  } catch (e) {
    return TALK
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
        '<title>TD Talk</title></head>' +
        '<body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff">' +
        '<div style="text-align:center;padding:24px">' +
        '<h1 style="color:#BE1E2D;font-size:22px;margin:0 0 12px">TD Talk</h1>' +
        '<p style="color:#6b7280;margin:0 0 4px">You are offline. Please check your connection.</p>' +
        '<button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#BE1E2D;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer">Retry</button>' +
        '</div></body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )
    })
  )
})

// Delivery receipt (dev job c1e326dd): a team-chat push that reaches this device means the message has been RECEIVED —
// tell the server so the sender's tick turns grey-double. Needs only the thread id from the notification address;
// pushes with no ?thread= (client messages, payments…) send nothing. Best effort, never blocks the notification.
function ackDelivered(data) {
  try {
    var m = /[?&]thread=([0-9a-fA-F-]{36})/.exec(String((data && data.url) || ''))
    if (!m) return Promise.resolve()
    return fetch('/api/team/delivered', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ thread_id: m[1] }] }),
    }).catch(function () {})
  } catch (e) { return Promise.resolve() }
}

// Push. A notification is ALWAYS shown (iOS drops a subscription that receives pushes it does not display).
self.addEventListener('push', function (event) {
  if (!event.data) return
  var data = event.data.json()
  var options = {
    body: data.body || '',
    icon: '/talk/icons/icon-192.png',
    badge: '/talk/icons/icon-192.png',
    tag: data.tag || 'talk-notification',
    data: { url: talkUrlFor(data.url) },
    vibrate: [200, 100, 200],
  }
  event.waitUntil(Promise.all([self.registration.showNotification(data.title || 'TD Talk', options), ackDelivered(data)]))
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var target = talkUrlFor(event.notification.data && event.notification.data.url)

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      // Only TD Talk windows: never a CRM window, even though both live on the same site.
      var mine = windowClients.filter(function (c) {
        try { return 'focus' in c && isTalkPath(new URL(c.url).pathname) } catch (e) { return false }
      })
      var client = mine.filter(function (c) { return c.frameType === 'top-level' })[0] || mine[0]
      if (!client) return clients.openWindow(target)

      // Ask the open page to go there itself (no reload, nothing typed is lost); if it never answers,
      // fall back to a full navigation (same pattern as dashboard-sw.js).
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
