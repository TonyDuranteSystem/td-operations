# Portal Chat — Read/Unread State
_Last verified against code: 2026-08-30 — Claude (portal-chats topic-scoped read fix)_

## What it is
Tracks, per message in `portal_messages`, whether staff has "seen" it — drives
the red unread badges in the CRM's Portal Chats page (sidebar per-thread count,
the global sidebar nav badge, and the per-topic pill badges inside a thread).
Client-side unread (what the client sees) is a separate, mirror-image concern
using the same column with roles reversed — not covered here.

## Business rules
- A client message is "unread" (for staff) until a staff member opens that
  thread/topic, or replies **in that same topic** (see
  `lib/portal/mark-thread-read.ts`). **A reply only clears its own topic —
  NOT the whole conversation** (changed 2026-08-30; see Gotchas below for why
  the earlier behavior was wrong).
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
    inclusion rule as above, and (since 2026-08-30) scoped to the SAME topic
    the reply was sent in — `markClientMessagesReadForStaffReply` takes a
    required `topic: string | null` param (`null` = General), applied as
    `.is('topic', null)` or `.eq('topic', topic)` on every query branch. All
    three callers must pass it: the dashboard reply route (computes `topic`
    once and reuses it for both the insert and the read-clear, so the two can
    never drift), the MCP portal-message-send tool, and the AI worker's
    portal-message-send path — the latter two always pass `null` because
    neither ever tags its own insert with a topic.
  - `app/(dashboard)/portal-chats/page.tsx` — `adminUnreadByTopic` (topic-pill
    badges) and the sidebar `threads` query (`get_portal_chat_threads_v2`,
    filters `sender_type='client'` only) are two SEPARATE counters computed
    differently; don't assume fixing one fixes the other.
  - `app/api/portal/chat/badge/route.ts` — global CRM sidebar nav badge,
    filters `sender_type='client'` only.

## Gotchas, invariants & past bugs
- **2026-08-30 bug (decision reversed from 2026-08-27's "clear the whole
  conversation" design):** a staff reply was clearing the unread flag on
  EVERY topic-tagged sub-thread of a client conversation, not just the one it
  was sent in — confirmed live on production, 18 real cases where a
  named-topic client message got silently marked read the instant staff
  replied in a different topic (most recent case one day before the fix
  shipped). The earlier design ("a reply means the whole conversation was
  seen") made sense back when topics were barely used; with real per-topic
  conversations it actively hid unanswered questions. Fixed by making
  `topic` a required parameter on `markClientMessagesReadForStaffReply` so a
  future caller can't silently regress this — see "How it's built" above.
  Same push also made the topic tabs sort unread-first/recency-second (was
  alphabetical) with a stronger pulsing highlight, and added a
  "Replying in: [topic]" label above the compose box on both the staff
  dashboard and the client portal, so which topic a reply lands in is always
  visible — this is now operationally load-bearing, not cosmetic.
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

-- Cross-topic clears (should be ~0 for anything AFTER 2026-08-30 — a nonzero
-- count on recent rows means the topic-scoping fix has regressed):
select count(*) from portal_messages c
join portal_messages a
  on a.sender_type='admin'
 and coalesce(a.account_id::text,a.contact_id::text) = coalesce(c.account_id::text,c.contact_id::text)
 and a.created_at between c.read_at - interval '4 seconds' and c.read_at + interval '4 seconds'
where c.sender_type in ('client','system') and c.read_at is not null
  and coalesce(c.topic,'') is distinct from coalesce(a.topic,'')
  and c.read_at > '2026-08-30';
```

Historical note: 18 messages were found wrongly marked read by the old
behavior, spanning multiple client accounts and topics (Amex, ITIN 2026, Tax
Return 2026, dichirazioni estro, and others). The code fix does not
retroactively correct existing `read_at` values on its own, only future
writes — that's a separate manual step. **Done, 2026-08-30, after the fix
shipped to production:** Antonio approved correcting the 18 once the code
fix was safely live (correcting first would have let the still-live bug
immediately re-clear them). All 18 confirmed reset to unread and verified —
both the direct row check and the cross-topic-clear query above returned 0
remaining immediately after.
