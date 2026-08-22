// Portal Service Worker — push notifications + offline fallback. NO CACHING.
//
// This worker stores NOTHING in Cache Storage. That is deliberate and is the
// rule in docs/systems/pwa.md ("No data/page caching in the SW beyond the
// offline fallback") — enforced by tests/unit/service-worker-no-page-cache.test.ts.
//
// WHY (incident 2026-07-21, dev job 454514f5): the previous version cached every
// successful GET under /portal, including server-rendered authenticated HTML, and
// replayed it whenever the network request failed. That produced three problems:
//   1. Cached Next.js shells reference build-specific /_next/ chunks, which this
//      worker never cached and which 404 after a deploy — so a replayed shell
//      rendered but never hydrated (portal visible, nothing usable).
//   2. The replay skipped every server-side auth gate: cached pages rendered a
//      client's ITIN, EIN, address and invoices offline with no session.
//   3. Portal signing pages embed a token+access-code URL that authenticates on
//      its own; caching them left a working signature link on the device.
// Sign-out never cleared any of it, and CACHE_NAME had not been bumped since
// 2026-04-02, so nothing was ever evicted.
//
// RECOVERY: this version calls skipWaiting() in install and, in activate, deletes
// ALL cache buckets and re-navigates every open window. That path runs entirely
// inside the worker — it does NOT depend on page JavaScript, which is exactly what
// a poisoned shell cannot run. Without it the fix would install, park in "waiting"
// forever, and never reach the clients it exists to rescue.
const SW_VERSION = 'td-portal-20260721-nocache'

self.addEventListener('install', function () {
  // Unconditional: this is a recovery release. There is no version-skew risk
  // because this worker caches nothing, so claiming mid-session is safe.
  self.skipWaiting()
})

// Kept for the update-banner flow (lib/hooks/use-sw-update.ts) on healthy clients.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        // Delete EVERYTHING, not just names !== current — the whole point is to
        // evict buckets written by older versions of this worker.
        return Promise.all(names.map(function (name) { return caches.delete(name) }))
          .then(function () { return names.length })
      })
      .then(function (purgedCount) {
        // Surfaced in DevTools so support can confirm which worker a client is on.
        console.log('[portal-sw] activated', SW_VERSION, 'purged', purgedCount, 'legacy cache(s)')
        return self.clients.claim().then(function () { return purgedCount })
      })
      .then(function (purgedCount) {
        // Only re-navigate when we actually purged a legacy cache. Those are the
        // installs that may be sitting on a dead shell; a fresh install has no
        // cache and must not be reloaded out from under the user.
        if (purgedCount === 0) return undefined
        return self.clients.matchAll({ type: 'window' }).then(function (windowClients) {
          return Promise.all(windowClients.map(function (client) {
            if ('navigate' in client) {
              return client.navigate(client.url).catch(function () {})
            }
            return undefined
          }))
        })
      })
      .catch(function () {
        // Never let activation fail — a failed activate leaves the OLD worker in
        // control, which is the exact state we are trying to escape.
      })
  )
})

// Offline fallback for page navigations ONLY. Nothing is cached, so this is a
// self-contained response — no cache.match, no precached route, no dependency on
// a middleware-public URL staying public (a failed precache would abort install
// and silently kill push for that client).
self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return
  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>TD Portal</title></head>' +
        '<body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc">' +
        '<div style="text-align:center;padding:24px">' +
        '<h1 style="color:#BE1E2D;font-size:22px;margin:0 0 12px">TD Portal</h1>' +
        '<p style="color:#6b7280;margin:0 0 4px">Sei offline. Controlla la connessione.</p>' +
        '<p style="color:#9ca3af;margin:0;font-size:14px">You are offline. Please check your connection.</p>' +
        '<button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#BE1E2D;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer">Riprova / Retry</button>' +
        '</div></body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )
    })
  )
})

// ─── Push notifications (unchanged behaviour — deliberately NOT folded into the
// dashboard worker's version, which has no app-badge handling) ───────────────
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

  // Reports to the existing client-error pipeline (POST /api/system-errors/report,
  // deduped by route+message — a repeat just bumps occurrence_count, never floods
  // the table) ONLY when badging did NOT work. Silent on success: this is the one
  // visibility we have into whether setAppBadge actually works for real clients —
  // previously swallowed entirely (`.catch(function () {})` with nothing else), so
  // a badge broken on every device was indistinguishable from a working one from
  // our side. Fire-and-forget; must never affect whether the notification itself
  // shows, and must never throw back into the caller.
  function reportBadgeIssue(message, context) {
    try {
      fetch('/api/system-errors/report', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          route: 'portal-sw:push:setAppBadge',
          message: message,
          context: context,
        }),
      }).catch(function () {})
    } catch {
      // Never let diagnostic reporting break notification delivery.
    }
  }

  var showAndBadge = self.registration.showNotification(data.title || 'TD Portal', options)
    .then(function () {
      if (!(self.navigator && 'setAppBadge' in self.navigator)) {
        reportBadgeIssue('setAppBadge is not available in this ServiceWorker context', {
          tag: data.tag || null,
        })
        return
      }
      return self.navigator.setAppBadge(data.badge || 1).catch(function (err) {
        reportBadgeIssue(
          'setAppBadge() rejected: ' + (err && err.message ? err.message : String(err)),
          { tag: data.tag || null },
        )
      })
    })

  event.waitUntil(showAndBadge)
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()

  // Clear the app badge when user interacts with a notification
  if (self.navigator && 'clearAppBadge' in self.navigator) {
    self.navigator.clearAppBadge().catch(function () {})
  }

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
