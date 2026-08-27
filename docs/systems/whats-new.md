# What's New (client-action chat-event feed)
_Last verified against code: 2026-08-26 — Claude (full audit of the What's New + To-Do board catalogs, prompted by Antonio's push to check the WHOLE event setup rather than one recent change. Found and fixed two gaps: (1) `aged_credit_applied` and `financials_confirm_unlocked` are both live `ChatEventKind`s with real call sites but had no `EVENT_KEY_LABELS` entry — added both. (2) Two catalog rows had a correctly-written seed migration sitting in the repo that was never actually promoted to production: `whats_new_events`/`plan_referrer_ready_to_release` (cosmetic — the event still showed via its own topic fallback "Referral", just without the intended label/toggle) and, more seriously, the sibling To-Do board's `action_events`/`itin_renewal_upcoming` (a real functional gap — without this row `emitActionNeeded()` silently creates no card at all; not yet a proven missed real-world case since the owning cron only runs in January and the feature was built after January 2026 already passed, but it would have silently failed on its next scheduled run). Both rows promoted to production directly, using sandbox's actual current content (which had drifted from the original migration file text on the ITIN row) rather than replaying stale file text. See todo-board.md for the ActEvent side of this same audit.)_
_Prior: 2026-08-25 — Claude (dev job fb527ac8: banking wizard submissions via the portal wizard never produced a marked note, so they never surfaced here — a plain migration gap, not a deliberate exclusion. Added `banking_wizard_submitted` to `ChatEventKind`, a matching `emitBankingWizardSubmittedEvent`/`retireBankingWizardSubmittedNote` pair in `lib/portal/chat-events.ts`, and a `banking_wizard_submitted` entry in `EVENT_KEY_LABELS` so the panel shows "Banking" instead of the raw key. This doc did not exist before this change — seeded now per R107, since a Council review needed two full passes to rediscover facts that belong here.)_

## What it is
A per-account/contact feed of system-authored notes inside a client's portal-chat
thread, surfaced to staff as a red-dot "What's New" panel — "what did this specific
client just do that needs our attention." It is the **passive, per-client** signal:
you have to already be looking at that client to see it. It is **NOT** the same
system as the Notification Center / "TO DO — FROM CHATS" board (see
[todo-board.md](todo-board.md)) — that is a **cross-client, push** board of assigned
action cards. The two are commonly confused because they are built and emitted in
the same call sites and sometimes share event-name strings by coincidence (e.g. both
now have something literally called `banking_wizard_submitted` — one is a
`ChatEventKind` here, the other is a dormant, unrelated `ActEvent` catalog slug in
`lib/notifications/act-event.ts` — they do not fire each other).

## Business rules
- Antonio, 2026-05-18: "every different submission or thing that the client does and
  need our attention for the next step" must produce a topic in the client's
  portal-chat thread with a red unread badge.
- Staff-only. A client must NEVER see one of these notes — see Gotchas.
- **R103 exclusion:** these are system messages, not conversation — they never
  trigger the client-email notification cron (`notifyClientOfAdminMessage`).

## How it's built
- **Tables / columns:** `portal_messages` rows with `sender_type='system'` whose
  `message` body ends in an HTML-comment marker: `<!-- chat-event: kind=<kind>
  src=<table>:<id> -->`. No dedicated table — the marker IS the event.
- **Key files:**
  - `lib/portal/chat-events.ts` — the ONLY place allowed to write this marker.
    `emitClientChatEvent()` is the primitive (idempotent insert + dedup pre-check);
    one small `emitXxxEvent()` wrapper per event source (payments, documents,
    SS-4, offers, decisions, the tax/banking wizards, etc.) formats that source's
    message and calls it. **New event source → add a wrapper here, no other code
    change** (the file's own stated contract).
  - `app/api/crm/admin-actions/whats-new/route.ts` — the reader. `?counts=true`
    drives the purple per-thread dot; `?notes=true&account_id|contact_id` returns
    the feed for one client. Both filter `portal_messages` for the marker via
    `ilike '%<!-- chat-event:%'`.
  - `components/portal-chats/thread-whats-new-panel.tsx` — the UI. `EVENT_KEY_LABELS`
    maps an event_key to a friendly badge (falls back to the raw key string if
    missing — a real, visible gap, not a graceful default); `deepLinkFor()` maps a
    source table to an "Open" button destination (several recent event kinds have
    neither — an accepted, low-priority pattern, not unique to any one of them).
  - `app/api/portal/chat/route.ts:108-133` — the ONE place deciding client vs staff
    visibility. **Any message containing the marker is unconditionally hidden from
    client reads** (`.not('message', 'ilike', '%<!-- chat-event:%')`); staff reads
    additionally hide only `kind=payment_received` specifically (a past-complaint
    fix, 2026-07-02 — "duplicated it in the wrong place"), so every other event kind
    still renders inline in the staff conversation view AND in the What's New panel.
- **Config / catalog:** `catalog_entries` where `catalog_id='whats_new_events'` —
  per-event `visible` toggle + `suggested_step` override (Board Settings). An
  event_key with **no row here defaults to VISIBLE** — most kinds, including
  `wizard_submitted` and `banking_wizard_submitted`, have no row at all today.
  `lib/notifications/whats-new-defaults.ts` (`WHATS_NEW_DEFAULT_STEPS`) is the
  code-side fallback "what to do" text when no catalog override exists.
- **Data flow (typical):** client action → route/handler calls the matching
  `emitXxxEvent()` → `emitClientChatEvent()` dedup-checks the marker → inserts →
  panel/dot pick it up on next poll/realtime refresh.

## Gotchas, invariants & past bugs
- **Dedup is permanent, not resolve-aware.** `emitClientChatEvent`'s idempotency key
  is `(source.table, source.id, event_kind)`, checked against `deleted_at IS NULL`
  only — there is no "has staff acted on this yet" reset. A source row that gets
  updated in place (not re-inserted) and fires the SAME event kind again — e.g. a
  client resubmitting a wizard for the same stable database row — produces **no
  second note, ever**, unless something explicitly retires the old one first
  (`retirePaymentReceivedNote`, `retireBankingWizardSubmittedNote` are the two
  existing retire-and-re-emit helpers; most event sources have none). Verified
  2026-08-25: this is not theoretical for banking — 7 real accounts in production
  have submitted the same provider 2-5 times, several separated by hours-to-weeks,
  before the retire helper existed. Check for a similar gap before adding any new
  wizard-style event source whose underlying row can be updated more than once.
- **A new `ChatEventKind` needs a friendly label or it renders as a raw string.**
  `EVENT_KEY_LABELS` in `thread-whats-new-panel.tsx` is not automatically kept in
  sync with the `ChatEventKind` union in `chat-events.ts` — add both in the same
  change.
- **The two-writes-per-event pattern exists on purpose for the banking wizard.**
  The client-visible confirmation for a banking submission was written BEFORE this
  primitive existed (commit `5500f263`, six weeks before `chat-events.ts` was
  created) and is a plain, unmarked `portal_messages` insert. Converting it into a
  marked note (instead of adding a second, separate marked note alongside it) would
  silently remove the client's own confirmation from their chat view — confirmed by
  reading `app/api/portal/chat/route.ts`'s client-side filter directly. Any future
  event source that ALREADY has a pre-existing client-visible chat note must follow
  the same two-write pattern, not replace it.
- **Two different "Notification Center"-sounding systems.** This doc (What's New,
  `portal_messages` markers) and [todo-board.md](todo-board.md) (`message_actions`
  cards via `emitActionNeeded`) are built independently and share literal event-name
  strings for several wizards (`tax_wizard_submitted`, `itin_wizard_submitted`,
  `formation_wizard_submitted`, `onboarding_wizard_submitted`, and now
  `banking_wizard_submitted`) purely by naming coincidence — firing one never fires
  the other. A session touching one must not assume it also covers the other.

## How to verify current state
- **A client's current What's New feed (staff view):**
  `GET /api/crm/admin-actions/whats-new?notes=true&account_id=<id>` (staff session).
- **Raw marker rows for one account:**
  `SELECT id, message, created_at, handled_at FROM portal_messages WHERE sender_type='system' AND account_id='<id>' AND message ILIKE '%<!-- chat-event:%' ORDER BY created_at DESC;`
- **Per-event visibility config:**
  `SELECT slug, metadata FROM catalog_entries WHERE catalog_id='whats_new_events' AND status='active';`
- Note (R096): use the **sandbox** MCP / `psql` for sandbox; `execute_sql` on the
  production MCP connection hits production.
