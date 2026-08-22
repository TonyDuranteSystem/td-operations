# Error Auto-Audit

Last verified against code: 2026-08-22b — Claude (**The badge-diagnostic caller (below) is exempted from the login requirement — the FIRST unauthenticated route this endpoint has ever accepted, dev job `61f62c08`.** Proven live, not assumed: the badge report's outbound request was confirmed reaching this endpoint (TLS handshake + valid certificate for our own domain, watched via the device's own network log) yet nothing ever landed in `system_errors` — the service worker's background push context does not reliably carry a login session, so the request was very likely getting the pre-existing 401 with nothing to show for it. Antonio's explicit call: build a version that does not depend on being logged in at all. **How it stays narrow, not a general "report anything" door:** a fixed allowlist (currently one entry, `portal-sw:push:setAppBadge`) is checked BEFORE the login check — only a request whose route exactly matches skips authentication; every other route is completely untouched, still requires login, still 401s exactly as before (regression-tested). An unauthenticated report is additionally rate-limited per IP (20/minute, the shared `lib/portal/rate-limit.ts` helper already used elsewhere) since nothing here identifies the caller, and still passes through the same size-capping every path already goes through. Captured with no email on the row (there is no session to attribute it to). Tests: `tests/unit/system-errors-report-route.test.ts`.)

Prior: 2026-08-22 — Claude (**New client-side caller: the portal service worker's push handler now self-reports a broken app-icon badge** — dev job `61f62c08`. `public/portal-sw.js`'s `push` event used to attempt `navigator.setAppBadge()` and swallow any outcome with an empty `.catch()` — a badge broken on every real client's phone was indistinguishable from one working correctly, from our side. It now posts to the same `/api/system-errors/report` client endpoint, but ONLY on a non-success outcome (unsupported in this context, or the call itself rejected) — silent on success, so this doesn't turn every working push into a fake "error" row; a real recurring failure shows up as one deduped row with occurrence_count counting exactly how many times it happened, and it going quiet is itself the signal that badging started working. Same known limitation as every other client-side caller below applies here too: if the push arrives after the browser session has expired, the report itself can silently 401 — accepted, not solved, matching the existing design.)

Prior: 2026-07-11 — Claude (**the 15-minute AI DIAGNOSIS loop is DISABLED** — unscheduled from vercel.json + `lib/cron-coverage.ts`, so it no longer runs, and the route file has now been DELETED. It ran an AI pass over captured errors every 15 minutes and wrote to a `/system-health` view no one opened — recurring token cost for nothing (Antonio, 2026-07-11). Error **capture** (`lib/system-errors.ts::reportSystemError`) and the `/system-health` view are UNCHANGED — errors are still recorded and visible; they just aren't auto-diagnosed anymore (the `diagnosis`/`suggested_fix` fields stay empty until someone diagnoses on demand). Monitoring moved to a point-of-work model instead: real client problems surface on the Portal Chats client (⚠️ + Issues tab, see `dev-tracker.md`/portal), and silent failures (a dead payment sync, orphaned records) fire ONE Team Chat alarm via `/api/cron/payment-integrity-alarm`. The daily audit / cron-coverage / weekly-report crons were also deleted. Original build note below.)

Original: 2026-07-07 (initial build)

## What it is

Automatic capture, deduplication, and AI diagnosis of runtime errors, surfaced
on `/system-health` ("System Errors — auto-audit" widget, top card). Goal:
when something breaks, Antonio sees WHAT happened, WHY, and WHAT TO DO — not a
bare "Unknown error" toast.

Origin: 2026-07-07 incident — an expired admin session made the offer dialog's
"Generate with AI" call hit the middleware login redirect; the login page
answered 405 + HTML, and the dialog collapsed that into "Unknown error" with
zero trace anywhere.

## How it works

1. **Capture → `system_errors` table** (service-role only, RLS enabled with no
   policies). One row per distinct failure `fingerprint` =
   sha256(source | route | http_status | normalized message). Normalization
   strips UUIDs, long numbers, hex, emails so repeats collapse. A repeat bumps
   `occurrence_count` + `last_seen`; a repeat of a resolved/ignored row REOPENS
   it with diagnosis cleared. Capture never throws (fire-and-forget).
   - **Server-side**: API route catch blocks call
     `reportSystemError()` from `lib/system-errors.ts`. Wired today:
     create-offer + generate-offer-narrative routes. Add to any route's catch.
   - **Client-side**: UI fetch failures POST to `/api/system-errors/report`
     (requires a logged-in user; dead-session errors can't self-report — by
     design, the middleware's 401 SESSION_EXPIRED body already explains those
     to the user directly. **One narrow, allowlisted exception** since
     2026-08-22b: a route on `UNAUTH_ALLOWED_ROUTES` in the route file skips
     the login check entirely, rate-limited per IP instead — built for a
     background Service Worker context that cannot be assumed to carry a
     session; every other route is unaffected). Wired today: create-offer
     dialog; the portal
     service worker's push handler (`public/portal-sw.js`, 2026-08-22 —
     reports a failed/unsupported app-icon badge only, silent on success).
2. **Diagnosis → cron** `/api/cron/error-audit` — **DELETED 2026-07-11**
   (unscheduled from vercel.json + `lib/cron-coverage.ts`, route removed).
   It used to run
   every 15 min, pick up to 5 `open` rows, call the AI provider and write a
   `diagnosis` + `suggested_fix` (status → `diagnosed`). That auto-diagnosis is
   gone — captured rows now stay `open` (no `diagnosis`) unless diagnosed on
   demand. See the header note for the why + what replaced it.
3. **Surface → `/system-health`** top widget
   (`components/system-health/system-errors-panel.tsx`): status badge,
   route, occurrence count, message, diagnosis + solution, Resolve / Ignore
   buttons (POST `/api/system-errors/update`, staff-only — clients 403).

## The session-expiry contract (middleware)

`middleware.ts` — when auth fails on an `/api/*` path and the request is a
background fetch (NOT a browser navigation, detected via
`Sec-Fetch-Mode: navigate` or `Accept: text/html`):

- No user → **401 JSON** `{ error, code: 'SESSION_EXPIRED' }` (was: 307 → login
  page → 405 HTML → garbage toasts).
- Banned user → **401 JSON** `{ error, code: 'ACCOUNT_SUSPENDED' }` + sb-*
  cookies cleared.
- Browser navigations to `/api/*` (document download links etc.) keep the
  login REDIRECT so humans land on the login screen.

Client contract: on any own-API fetch failure, read the body as TEXT first,
try JSON.parse, check `status === 401 || code === 'SESSION_EXPIRED'` → show
the session-expired message; otherwise surface `error` or `HTTP <status>` and
fire-and-forget a report. Reference implementation: `readErrorBody` /
`isSessionExpired` / `reportDialogError` in
`components/offers/create-offer-dialog.tsx`.

## Rules

- Dedup is mandatory: NEVER insert system_errors rows directly — always
  `reportSystemError()` (it fingerprints + upserts). Lesson: the
  audit-health-check cron creates a duplicate dev_task every run; this system
  must not repeat that.
- Capture must be best-effort: never let reporting break the flow that is
  already failing (wrap in try/catch, `.catch(() => {})`).
- Diagnosis writes only via the cron; UI status changes only via
  `/api/system-errors/update` (open/resolved/ignored).
- The `system_errors` table is service-role only — no RLS policies, no client
  reads.

## How to verify current state

- Table exists: `SELECT count(*) FROM system_errors` (sandbox ref
  xjcxlmlpeywtwkhstjlw / prod ydzipybqeebtpcvsbtvs).
- Capture: hit an instrumented route's failure path, check a row appears and a
  second identical failure increments `occurrence_count` (no new row).
- 401 contract: `curl -X POST https://<env>/api/crm/admin-actions/create-offer`
  (no cookies) → expect 401 JSON with code SESSION_EXPIRED; same URL with
  `-H 'Accept: text/html'` → expect 307 redirect to /login.
- Diagnosis: `curl -H "Authorization: Bearer $CRON_SECRET" https://<env>/api/cron/error-audit`
  → open rows gain diagnosis/suggested_fix, status → diagnosed.
- Unit tests: `npx vitest run tests/unit/system-errors.test.ts`.

## Files

- `lib/system-errors.ts` — fingerprint/clamp/report/list/diagnose (pure helpers unit-tested)
- `app/api/system-errors/report/route.ts` — client capture (auth required)
- `app/api/system-errors/update/route.ts` — staff status updates
- `app/api/cron/error-audit/route.ts` — AI diagnosis pass
- `components/system-health/system-errors-panel.tsx` — /system-health widget
- `scripts/migrations/20260707-0900-system-errors-auto-audit.sql` — table
- `middleware.ts` — SESSION_EXPIRED / ACCOUNT_SUSPENDED 401 JSON contract
