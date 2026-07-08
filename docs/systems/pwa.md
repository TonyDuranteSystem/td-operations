# PWA (installable app shell — dashboard + portal)
_Last verified against code: 2026-07-08 — Claude (created during the PWA mobile UX pass, dev_task `e1f28dce`: SW public prefixes, push-subscribe consolidation, admin-sw.js deletion, offline fallback page. Antonio runs the ENTIRE CRM as an installed phone PWA — treat mobile as a first-class surface.)_

## What it is
Both surfaces install as PWAs: the staff **CRM dashboard** (this doc's focus) and the **client portal**. The PWA layer = a web-app manifest, a hand-written service worker per surface (no next-pwa/serwist/workbox), a push-notification pipeline, an update-prompt mechanism, and an offline fallback page. The service workers deliberately do **NOT cache data or pages** (beyond `/offline`) — a live CRM must never show stale financials.

## Parts (dashboard)
- **Manifest** `public/manifest.webmanifest` — name "TD Operations", `start_url: /`, `display: standalone`, icons from `/portal-icons/` (192/512 + maskable; shared with the portal — no dashboard-specific icon set, deliberate until a design decision says otherwise). Linked via `metadata.manifest` in `app/(dashboard)/layout.tsx`; theme-color/apple-touch-icon/appleWebApp in the root `app/layout.tsx`.
- **Service worker** `public/dashboard-sw.js` — versioned `CACHE_NAME` (`td-dashboard-vN`, bump when precached assets change). Handles: install (precaches `/offline`), activate (deletes old caches, `clients.claim()`), `SKIP_WAITING` message, `push` + `notificationclick` (focuses/opens `/portal-chats` by default), and a **navigation-only network-first fetch handler** that serves the cached `/offline` page when the network fails. Non-navigation requests (API, assets) are never intercepted.
- **Offline page** `app/offline/page.tsx` — self-contained server component (inline styles, no client JS) so it renders from SW cache without framework chunks.
- **Registration + update flow** — `components/dashboard/sw-register.tsx` (mounted in `app/(dashboard)/layout.tsx`) → `components/shared/update-banner.tsx` → `lib/hooks/use-sw-update.ts`: registers the SW, polls `reg.update()` every 60s, shows an update banner, applies via `SKIP_WAITING` + reload on `controllerchange`, force-updates after 24h.
- **Push subscribe** — `lib/push/dashboard-push.ts::subscribeToDashboardPush()` is the ONE implementation (register → VAPID key from `/api/admin/push` → permission → subscribe → POST). Callers: `components/dashboard/push-toggle.tsx` (header + sidebar) and the portal-chats `enableNotifications` handler. The portal's own toggle (`components/portal/push-toggle.tsx`, different endpoints) shares only `urlBase64ToUint8Array`. **Never re-roll this sequence inline.**
- **Middleware** — `middleware.ts` `PUBLIC_PREFIXES` must include `/manifest.webmanifest`, `/dashboard-sw.js`, `/portal-sw.js`, `/offline`: the matcher's extension exclusions don't cover `.js`, and the browser refetches SW scripts + the SW fetches `/offline` at install **without a session**. Auth-gating any of these silently breaks SW updates / install.

## Portal differences
`public/portal/manifest.webmanifest` + `public/portal-sw.js` (registered from `app/portal/layout.tsx` / `components/portal/portal-sw-register.tsx`); portal push uses its own endpoints. Not otherwise covered here — see `portal.md`.

## The rules
1. Mobile-first is mandatory for dashboard UI: Antonio uses every page from a ~380px phone. Tables need scroll wrappers (`overflow-x-auto` + `min-w-[...]`) or card collapse; toolbars need `flex-wrap`; grids need responsive prefixes.
2. Any new public PWA asset (SW, manifest, precached page) goes in `PUBLIC_PREFIXES`.
3. Bump `CACHE_NAME` when changing what the SW precaches.
4. No data/page caching in the SW beyond the offline fallback.
5. New push entry points call `subscribeToDashboardPush()` — no inline copies.

## How to verify current state
- Logged OUT: `curl -sI https://<host>/dashboard-sw.js` and `/offline` → 200 (not 307 to /login).
- DevTools → Application → Service Workers: `dashboard-sw.js` activated at scope `/`; Cache Storage has `td-dashboard-vN` containing `/offline`.
- DevTools → Network → Offline, reload any dashboard page → the offline page renders (styled, with Retry).
- Push: dashboard header bell → enable → Test button sends via `/api/admin/push/test`.
