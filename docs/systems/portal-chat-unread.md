# Portal Chat — Read/Unread State
_Last verified against code: 2026-09-23 — Claude (chat-events excluded from the three staff-facing display indicators; What's New is now their only unread signal)_

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
  someone opened the conversation for an unrelated reason. **`read_at` is
  never set on these rows by any mark-as-read path — that part is permanent,
  not a bug.** The read-marking ROUTES (`read/route.ts`, `mark-thread-read.ts`)
  never touch these rows, unchanged since 2026-09-17.
  **What changed 2026-09-23 (Antonio):** the three staff-facing DISPLAY
  indicators below now EXCLUDE chat-event rows entirely, regardless of
  `handled_at` — Antonio found the same notice showing an unread count on
  both the Topic pill and the What's New tab at once confusing. What's New is
  now the ONLY surface where a chat-event notice contributes an unread count
  or highlight; the Topic pill, the "Jump to latest" counter, and the
  message's own amber pill all stay fully quiet for chat-event rows from the
  moment they're created, whether handled or not. This is a narrower reading
  of the original 2026-05-18 requirement ("every client action must produce a
  topic with a red unread badge") — the topic still gets created and is still
  visible in the conversation, it just no longer double-signals unread once
  What's New already owns that signal. **Known, accepted trade-off:** a topic
  whose only content is an un-handled chat-event no longer sorts to the front
  of the topic-tab strip (`adminTopicOrder` treats it as read) — staff finds
  it via What's New or the sidebar's purple dot, not via tab order. (The
  2026-09-17 handled_at-aware logic described below is now superseded by this
  simpler exclude-always rule for these three indicators — the history is
  kept for context, not because the mechanism still applies.)

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
  - `app/(dashboard)/portal-chats/page.tsx` — THREE separate staff-facing
    "unread" indicators live in this one file, all reading `combinedMessages`
    directly (not a server aggregate): `adminUnreadByTopic` (topic-pill
    badges), `recomputeJumpState`/`unreadBelowCount` (the "Jump to latest ↓N"
    floating badge), and the per-message amber pill on system-notice bubbles
    (`isUnread` inside the `isSystem` render branch). As of 2026-09-23, all
    three unconditionally EXCLUDE any row matching `isChatEventMessage()`
    (shared helper in `lib/portal/chat-scope.ts`) — chat-events never
    contribute to these three, handled or not; What's New is their only
    unread signal now (see Gotchas below for why this changed from the prior
    2026-09-17 `handled_at`-aware version). These are
    SEPARATE from the sidebar `threads` query (`get_portal_chat_threads_v2`,
    filters `sender_type='client'` only) and the global nav badge (below) —
    don't assume fixing one fixes the others.
  - `app/api/portal/chat/badge/route.ts` — global CRM sidebar nav badge,
    filters `sender_type='client'` only.
  - `lib/portal/chat-scope.ts` — `isChatEventMessage(message)`, the shared
    client+server-safe helper that detects the `<!-- chat-event: -->` marker
    (see `lib/portal/chat-events.ts`). Lives here (not in `chat-events.ts`,
    which imports `supabaseAdmin` and can't be pulled into a `'use client'`
    file) specifically so the three page.tsx indicators above don't each
    hand-roll their own copy of this check.

## Gotchas, invariants & past bugs
- **2026-09-17 bug: a handled chat-event notice stayed visually "unread" forever, on THREE separate indicators.**
  `adminUnreadByTopic` (topic-pill badges), `recomputeJumpState`/`unreadBelowCount`
  (the "Jump to latest ↓N" floating badge), and the per-message amber pill on
  system-notice bubbles all computed "unread" as `sender_type !== 'admin' &&
  !read_at`, with no awareness of chat-event rows or `handled_at`. Since a
  chat-event row's `read_at` is permanently null by design (see Business rules
  above), any topic that ever received one stayed red — and its message bubble
  amber — forever, even after staff explicitly marked it handled in What's New.
  Confirmed live in production before the fix: 78 already-handled chat-event
  rows stuck with `read_at IS NULL` system-wide (2 of them on one real account,
  both handled the same day they arrived). Found via a 5-reviewer council pass
  on the initial 1-site fix proposal — senior-engineer, bug-hunter, and
  project-director independently found the other two sites the same day.
  Fixed by adding a shared `isChatEventMessage()` helper (`lib/portal/chat-scope.ts`)
  and, at all three sites, treating a chat-event row as cleared once EITHER
  `read_at` OR `handled_at` is set (every other row type is unchanged, still
  keyed on `read_at` alone). A brand-new, not-yet-handled chat-event still
  shows red/amber immediately — deliberately preserved, per Antonio's original
  2026-05-18 requirement that a new client action must be visible right away.
  **Follow-up same day:** a pre-existing, separate gap in `adminUnreadByTopic`
  (predates this fix — confirmed via `git show` on the fix's own commit, the
  line was untouched context, not introduced by it) meant it was the only one
  of the three sites that never excluded `deleted_at`. A chat-event note gets
  soft-deleted, never re-created, whenever a client corrects and resubmits
  something before staff handled the original (`retireWizardSubmittedNote`
  and its siblings in `lib/portal/chat-events.ts` — real, live call sites, not
  theoretical). A retired note that was never handled first is invisible to
  every clearing path (excluded from read-clear queries by the chat-event
  marker exclusion, excluded from the What's New feed by its own `deleted_at`
  filter) — so before this follow-up, it inflated `adminUnreadByTopic` with a
  permanent, un-clearable phantom count, the one case this whole fix didn't
  yet cover. Caught by a Bug Hunter pass run deliberately against the shipped
  commit (not the plan) before production. Fixed by adding the same
  `|| m.deleted_at` exclusion the other two sites already had.
  No backfill needed — existing stuck rows self-resolve the moment the fix
  ships, since it reads `handled_at`, which was already correctly set on them.
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
-- Already-handled chat-event notices with read_at still null: EXPECTED to be
-- nonzero forever (read_at is permanently null on these by design) — this is
-- what the three page.tsx indicators are now handled_at-aware about. Useful
-- as a spot-check of the underlying population, NOT as a "should be 0" health
-- check (unlike the plain-notices query below) — the frontend fix can't be
-- verified from SQL alone, since it doesn't change any stored data. Verify the
-- actual badge/pill/jump-count behavior in the browser instead.
select count(*) from portal_messages
where sender_type='system' and message ilike '%<!-- chat-event:%'
  and read_at is null and handled_at is not null;

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
