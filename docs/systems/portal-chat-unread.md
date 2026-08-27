# Portal Chat — Read/Unread State
_Last verified against code: 2026-08-27 — Claude (dev job cdd33e0b)_

## What it is
Tracks, per message in `portal_messages`, whether staff has "seen" it — drives
the red unread badges in the CRM's Portal Chats page (sidebar per-thread count,
the global sidebar nav badge, and the per-topic pill badges inside a thread).
Client-side unread (what the client sees) is a separate, mirror-image concern
using the same column with roles reversed — not covered here.

## Business rules
- A client message is "unread" (for staff) until a staff member opens that
  thread/topic, or replies to it (a reply implies the whole conversation up to
  that point was seen — see `lib/portal/mark-thread-read.ts`).
- A **plain system notice** (the out-of-office auto-reply, a bank-statement
  processing note, etc.) behaves the same way — it must be acknowledged by
  opening/replying, otherwise it stays "unread" forever.
- A **chat-event notice** (client signed something, paid, uploaded a document,
  submitted a wizard — the ~14 kinds in `lib/portal/chat-events.ts`) is
  **NOT** acknowledged this way. Its "seen" signal is a separate column,
  `handled_at`/`handled_by`, toggled explicitly by staff in the What's New
  panel (see `docs/systems/whats-new.md`). This is deliberate: a client action
  that still needs a human response must not silently disappear just because
  someone opened the conversation for an unrelated reason.

## How it's built
- **Table/columns:** `portal_messages.read_at` (staff-unread signal for
  client + plain-system rows), `portal_messages.handled_at`/`handled_by`
  (staff-unread signal for chat-event rows), `portal_messages.sender_type`
  (`client` / `admin` / `system` — DB CHECK constraint, exhaustive).
- **Chat-event marker:** every `emitClientChatEvent` insert carries
  `<!-- chat-event: kind=... src=... -->` in the message body
  (`lib/portal/chat-events.ts`). This string is the ONLY way to distinguish a
  plain system notice from a chat-event notice — filter with
  `NOT message ILIKE '%<!-- chat-event:%'` for "plain", the positive match for
  "chat-event".
- **Key files:**
  - `app/api/portal/chat/read/route.ts` — `POST`, fired when staff opens a
    thread or switches to a named topic tab. Admin callers mark `client` rows
    AND plain `system` rows (never chat-event rows) as read, scoped to
    account/contact + optional topic.
  - `lib/portal/mark-thread-read.ts` — fires automatically inside the message
    send route whenever staff sends a reply (`senderType==='admin'`). Same
    inclusion rule as above, but clears the WHOLE conversation across every
    topic (a reply means everything up to now was seen).
  - `app/(dashboard)/portal-chats/page.tsx` — `adminUnreadByTopic` (topic-pill
    badges) and the sidebar `threads` query (`get_portal_chat_threads_v2`,
    filters `sender_type='client'` only) are two SEPARATE counters computed
    differently; don't assume fixing one fixes the other.
  - `app/api/portal/chat/badge/route.ts` — global CRM sidebar nav badge,
    filters `sender_type='client'` only.

## Gotchas, invariants & past bugs
- **2026-08-27 bug (this doc's origin):** the topic-pill badge counted ALL
  non-admin, non-read messages — including `system` rows — but no mark-as-read
  path ever touched `sender_type='system'`, so any topic that ever got a
  system notice stayed "unread" forever, immune to opening or replying.
  Fixed by extending the two mark-as-read paths above to also clear plain
  system rows, explicitly excluding chat-event rows (which must stay gated on
  `handled_at`, or an unhandled client action could get silently marked "seen"
  the moment staff merely opens the conversation for something unrelated).
- **Never widen a mark-as-read query to plain `sender_type='system'`** without
  also excluding the chat-event marker — that would defeat the
  `handled_at` mechanism's entire purpose.
- Client-facing surfaces (the client's own unread badges) never read a
  `system` row's `read_at` at all — confirmed no client-side consumer does —
  so nothing here is client-visible; it only affects what staff sees.

## How to verify current state
```sql
-- Stuck plain notices (should be near 0 shortly after this fix ships + backfills):
select count(*) from portal_messages
where sender_type='system' and read_at is null
  and message not ilike '%<!-- chat-event:%';

-- Genuinely-still-open chat-event notices (expected to be nonzero — these are
-- real, legitimately awaiting a handled_at, not a bug):
select count(*) from portal_messages
where sender_type='system' and message ilike '%<!-- chat-event:%'
  and handled_at is null;
```
