# To-Do Board — "TO DO — FROM CHATS" (staff action cards)
_Last verified against code: 2026-06-14 — Claude (ITIN renewal → To-Do cards. Added `itin_renewal_upcoming` to `ActEvent` union type. Catalog entry (scope=contact, assignee=Luca) seeded in migration `20260614-1201`. January cron in `deadline-reminders/route.ts` replaced old June/tasks pattern with `emitActionNeeded` → source_ref `itin_renewal:<contact_id>:<year>`. Two triggers: (a) 3-year rule — `itin_renewal_date` on contact falls in current year; (b) IRS middle-digits batch — `itin_expiring_digits` table (new, migration `20260614-1200`). OCR paths (contact-actions + upload-document) now call `writeITINFields` to auto-populate `itin_renewal_date`. Onboarding/tax-intake wizards check renewal on wizard submit if ITIN is provided.)_
_Prior: 2026-06-10 — Claude (Slice 9: RA Renewal + Annual Report → To-Do cards. The `ra-renewal-check` / `annual-report-check` crons now emit a card via `emitActionNeeded` (`action_events` rows `ra_renewal_upcoming` / `annual_report_upcoming`, source_ref `ra_renewal:<sd>` / `annual_report:<sd>`) instead of an old `tasks` row — idempotent per source_ref, SD + email + blocked→Antonio-task kept. New `TaxRenewalActions` sub-component in `action-board.tsx` renders on those cards: a primary "Renew on Harbor" link (RA) + "Mark Done" which REQUIRES a receipt upload (REV 4.1) → `POST /api/crm/renewal/file` → existing `fileRenewal` (Drive upload + SD complete + ra_renewal_date/annual_report_due_date +1y) → card resolved to "done". Issue/Blocked = the board's existing move/priority controls.)_
_Prior: 2026-06-09 — Claude (Slice 4: TaxReviewActions sub-component for tax_submission:* source_ref cards)_

## What it is
A staff-only kanban board on the CRM dashboard ("TO DO — FROM CHATS"). Each card is
an action the team needs to take — usually triggered by a client portal-chat message
or a system event. Staff drag cards between columns, set reminders/priority, snooze
them, or send the client a follow-up. It is **internal**: a client must never see it.

This is the CRM dashboard, not the client portal.

## Business rules
- A card is **"open"** while `resolved_at IS NULL`. Moving a card into a **terminal**
  column (catalog `metadata.terminal = true`, e.g. "Done") stamps `resolved_at`;
  moving it to any non-terminal column clears it. "Open" is defined by `resolved_at`,
  **not** by `action_type != 'done'` — so renaming/adding columns never strands cards.
- **Snooze** (`snoozed_until` in the future) hides a card from every open-card reader
  until that time. Re-adding a To-Do from the message menu clears any snooze.
- **Default assignee** when none is given is resolved by `defaultTaskAssignee()`
  (`lib/tasks/default-assignee.ts`; env `DEFAULT_TASK_ASSIGNEE`, falls back to "Luca").
- **Follow up** action: posts a reminder into the client's portal chat (which also
  fires the normal client email notification, throttled per R103), then moves the
  card to the "Followup Sent" column.

## How it's built
- **Tables / columns:**
  - `message_actions` — the cards. Key columns: `action_type` (the column slug —
    plain `text`), `label`, `assigned_to`, `priority` (`normal|high|urgent`),
    `remind_at`, `snoozed_until`, `resolved_at`, `message_id` (NULL for system/staff
    cards), `account_id`, `contact_id`, `source_ref`, `created_at`, `updated_at`.
  - `catalog_entries` where `catalog_id = 'action_board_columns'` — **the columns are
    catalog-driven** (slug, display_name, `metadata.order`, `metadata.terminal`).
    Adding/renaming a column is a catalog edit, **not** a code change.
- **Active column slugs (verified 2026-05-29):** `action_needed` (Action needed),
  `in_progress` (In progress), `waiting_on_client` (Waiting on client),
  `send_followup` (**"Followup Sent"**), `wait_for_irs` (Wait for the IRS),
  `done` (Done — terminal).
- **Key files:**
  - `components/dashboard/action-board.tsx` — the board UI (columns, cards, the
    Follow-up modal, snooze/reminder/priority controls, 30s poll + refetch-after-move).
  - `app/api/crm/admin-actions/message-actions/route.ts` — the API.
    `GET` (?columns, ?open, ?snoozed, ?counts), `POST` (tag a message → one card per
    message, validates slug against the catalog), `PATCH` (move a card / set
    reminder/priority/snooze; validates slug against the catalog; terminal slug stamps
    `resolved_at`). Staff-only via `requireStaff()`.
  - `lib/notifications/act-event.ts` — `emitActionNeeded()` creates a card from a
    system event; it only ever writes the lowest-order column (`action_needed`).
  - `lib/errors/explain-failure.ts` — `explainFailure()` turns a DB error into a
    readable message (used by the route's catch blocks).
- **Validation source of truth:** `loadColumns()` in the route reads the catalog and
  rejects any `action_type` not active in `catalog_entries`. The **catalog + this
  app-level check are the single source of truth** for valid columns.
- **Follow-up data flow:** UI `sendFollowUp()` → `POST /api/portal/chat`
  (sends the reminder, the client is emailed) → on success, `move(card.id,
  'send_followup')` → `PATCH` the card's `action_type`. The chat send and the card
  move are **two separate requests** (this matters — see gotchas).

## Gotchas, invariants & past bugs
- **The chat reminder and the card move are independent.** If the move fails, the
  client has still already received the reminder. A "message sent but card stuck"
  symptom = the move (PATCH) failed, not the chat.
- **PAST BUG — "Follow up → [object Object]" (fixed 2026-05-29):** production had a
  stale CHECK constraint `message_actions_action_type_check` allowing only the 4
  original slugs (`action_needed/in_progress/waiting_on_client/done`). Moving a card
  to `send_followup` or `wait_for_irs` was rejected by Postgres (SQLSTATE 23514).
  supabase-js returns a failed write as a **plain object** in the `{data,error}`
  tuple (not an `Error` instance), and the route did `String(err)` → `"[object
  Object]"`, masking the cause while the card silently stayed put. **Fix:** dropped
  the constraint (catalog is the source of truth; sandbox never had it), and the
  route's catch blocks now use `explainFailure()`. **Invariant going forward:** do
  NOT re-add a hard-coded `action_type` CHECK constraint — new columns are added via
  the catalog, and a CHECK would re-break them.
- supabase-js errors are plain objects with a `.message` string, NOT `Error`
  instances, in default (non-`throwOnError`) mode. Never `String(err)` them — use
  `explainFailure()` (or read `.message`).

## How to verify current state
- **Columns:**
  `SELECT slug, display_name, metadata FROM catalog_entries WHERE catalog_id='action_board_columns' AND status='active' ORDER BY (metadata->>'order')::int;`
- **No stale CHECK constraint on action_type:**
  `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='message_actions'::regclass AND contype='c';`
  (Expect a `priority` check, and NO `action_type` check.)
- **A sample of open cards:**
  `SELECT id, action_type, label, resolved_at FROM message_actions WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 10;`
- Note (R096): use the **sandbox** MCP / `psql` for sandbox; `execute_sql` on the
  production MCP connection hits production.
