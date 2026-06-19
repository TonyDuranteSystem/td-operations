# Client Decision Requests

_Last verified against code: 2026-06-18 — Claude (built per docs/specs/CLIENT-DECISION-REQUESTS.md; sandbox table applied via migration 20260617-client-decision-requests.sql. UPDATE: the standalone staff `decision_requests` component was REMOVED — decision requests are backend plumbing with NO staff-visible component. Feature code creates them; the formation Name Command Center (`formation_names`, see flows.md) is the staff surface that drives them. Branch feat/formation-workspace-v2.)_

## What it is
A reusable system for getting a **structured** response from a client into a flow: staff (or automation) create a request scoped to a `service_delivery`, the client answers in the portal, the answer is recorded immutably, and the system can react. Replaces ad-hoc free-text chat for approvals/choices. First consumer: the formation LLC-name flow.

**Three generic types only** (never add a 4th — specificity lives in title/message/options):
- `approval` — yes/no → response `{ decision: 'approved'|'rejected', note? }`
- `choice` — pick one → response `{ selected: <key>, note? }`
- `text_input` — free text → response `{ text }`

## How it works
- **Table** `client_decision_requests` (migration `20260617-client-decision-requests.sql`). RLS enabled, NO policy — all access is via service-role API routes (the handlers enforce auth + ownership). Columns per the spec; `status` ∈ pending/approved/rejected/responded/expired/cancelled; `options`/`response` are JSONB; `auto_advance_on` optional; `notify_on_response` default true.
- **Pure core** `lib/decisions/index.ts` — types + `validateDecisionResponse(type, raw, options)` (normalizes + returns the resulting status) + `validateDecisionOptions` + `DecisionRequest` row type. Unit-tested (`tests/unit/decisions.test.ts`).
- **Operations** `lib/operations/decision-request.ts` (server, untyped table accessor) — `createDecisionRequest` (validates, resolves contact/account/stage from the SD, inserts, notifies the client), `respondToDecisionRequest` (validates, TOCTOU-guarded update on `status='pending'`, action_log, What's New event, optional auto-advance), plus read helpers (`getDecisionRequest`, `listDecisionRequestsForSd`, `listPendingDecisionsForContact`).
- **API routes** under `app/api/portal/decisions/` — `create` (POST, staff: role≠'client'), `route.ts` (GET `?sd_id=`, staff list), `[id]` (GET, staff or owning client), `[id]/respond` (POST, owning client), and `app/api/portal/my-decisions` (GET, client's pending). Middleware only requires an authenticated Supabase user on `/api/portal/*`; each handler enforces staff-vs-client + ownership (contact-scoped or 'documents' account access).
- **Staff UI — NONE dedicated.** Decision requests are backend plumbing; feature code creates them. The formation **Name Command Center** (`components/flows/formation-names.tsx`, the `formation_names` stage component) is the staff surface: marking a name "Send to Client" calls `createDecisionRequest` (an `approval`, options tagged with a `name_check` marker); "SOS Rejected" creates a `text_input` for new names. See flows.md + lib/operations/formation-name-checks.ts.
- **Response hook** — `respondToDecisionRequest`, after recording, calls `applyNameDecisionResponse` IFF `options.name_check` is present, flipping the SD's `name_checks` (accepted/rejected_by_client, or appending client-proposed names). This is the only place decisions touch formation; the marker keeps the core type-agnostic.
- **Client UI** `components/portal/decision-card.tsx` — renders a request as an actionable card (approval buttons / choice radios / text field), or read-only once answered. EN/IT (message_it). Shown in two places: (1) **portal-wide** via `components/portal/pending-decisions.tsx`, mounted in `app/portal/layout.tsx`, which fetches `GET /api/portal/my-decisions` and shows the client's pending requests under "Action required" on every portal page (self-hides when none) — the primary surface, tier-agnostic; (2) on `/portal/flows/[id]` (newest pending actionable, history read-only).

## Notifications
- **On create:** `createPortalNotification` to the client (type `'decision'`, links to `/portal/flows/[sd]`).
- **On response:** `action_log` row (`action_type='decision_response'`) + a staff What's New note via `emitDecisionRespondedEvent` (new chat-event kind `decision_responded`, labeled "Decision"). Gated by `notify_on_response`.

## Auto-advance
If `auto_advance_on` is set and the client **approves**, `respondToDecisionRequest` calls `advanceServiceDelivery(target_stage)`. Optional — names intentionally do NOT auto-advance (staff files manually).

## Gotchas / invariants
- **Only 3 types.** Anything more specific is a configured instance — do not add request_type values.
- **Immutable responses.** A new question = a new row; responses are never edited. The row set for an SD is the full decision history.
- **TOCTOU:** respond updates `WHERE id=? AND status='pending'` — only the first responder wins.
- **Table not in generated DB types yet** — server reads/writes use an untyped `(supabaseAdmin as any)` accessor in the operations module; `action_log.details` casts the response `as unknown as Json`.
- **Production promotion:** apply `20260617-client-decision-requests.sql` via `execute_sql(reason:"migration:…")`. Sandbox already has it.

## How to verify current state
- Table: `SELECT column_name FROM information_schema.columns WHERE table_name='client_decision_requests'`.
- A flow's requests: `SELECT id, request_type, status, title FROM client_decision_requests WHERE service_delivery_id='<sd>' ORDER BY created_at DESC`.
- Unit tests: `tests/unit/decisions.test.ts`.
- Formation Wizard Submitted / Filed with State stage_layouts carry the `decision_requests` component.
