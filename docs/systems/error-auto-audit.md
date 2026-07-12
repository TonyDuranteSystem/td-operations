# Error Auto-Audit

Last verified against code: 2026-07-11 — Claude (**the 15-minute AI DIAGNOSIS loop is DISABLED** — unscheduled from vercel.json + `lib/cron-coverage.ts`, so it no longer runs (the route file is left dormant, pending a separate deletion). It ran an AI pass over captured errors every 15 minutes and wrote to a `/system-health` view no one opened — recurring token cost for nothing (Antonio, 2026-07-11). Error **capture** (`lib/system-errors.ts::reportSystemError`) and the `/system-health` view are UNCHANGED — errors are still recorded and visible; they just aren't auto-diagnosed anymore (the `diagnosis`/`suggested_fix` fields stay empty until someone diagnoses on demand). Monitoring moved to a point-of-work model instead: real client problems surface on the Portal Chats client (⚠️ + Issues tab, see `dev-tracker.md`/portal), and silent failures (a dead payment sync, orphaned records) fire ONE Team Chat alarm via `/api/cron/payment-integrity-alarm`. The daily audit / cron-coverage / weekly-report crons were also unscheduled (dormant). Original build note below.)

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
     to the user directly). Wired today: create-offer dialog.
2. **Diagnosis → cron** `/api/cron/error-audit` — **DISABLED 2026-07-11**
   (unscheduled from vercel.json + `lib/cron-coverage.ts`; route left dormant).
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
