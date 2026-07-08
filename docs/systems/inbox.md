# Inbox (CRM unified inbox — Gmail + WhatsApp/Telegram)
_Last verified against code: 2026-07-08 — Claude (inbox audit + rendering/threading/color-marks overhaul; responsive thread header)_

## What it is

The `/inbox` tab of the CRM dashboard: a **live window onto Gmail** (support@ and
antonio@ mailboxes) plus the WhatsApp/Telegram messaging groups stored in
Supabase. **Nothing Gmail-related is persisted in our DB** — every list/thread
view is fetched from the Gmail API on demand (SA + DWD impersonation, see
`lib/gmail.ts`). WhatsApp/Telegram messages live in `messaging_groups` /
`messages` and are read-only here except replies via the `send-message` Edge
Function.

## How it works

- **Page**: `app/(dashboard)/inbox/page.tsx` → `components/inbox/inbox-shell.tsx`
  (channel tabs, mailbox toggle support@/antonio@, search, bulk actions, labels
  sidebar).
- **Conversation list**: `app/api/inbox/conversations/route.ts`. Lists Gmail
  threads (default `labelIds=INBOX`, or `q=in:<label>` / search query), fetches
  per-thread metadata, finds the external (non-TD) party, and matches their
  email against `account_contacts → contacts.email/email_2` to label the row
  with the CRM account. Polled every 30s by `conversation-list.tsx`.
- **Thread view**: `app/api/inbox/messages/[id]/route.ts` for `gmail:<threadId>`
  IDs fetches the full thread. Each message body:
  - HTML extracted by `extractBodyHtml` (`lib/gmail.ts`);
  - inline images (`src="cid:..."`) rewritten to
    `/api/inbox/attachment?...` via `extractInlineImages` (`lib/gmail.ts`) +
    `rewriteCidSources` (`lib/inbox/email-html.ts`); inline-rendered attachments
    are filtered out of the attachment chip list;
  - sanitized with `sanitizeEmailHtml` (`lib/html-escape.ts`) — regex-based;
    blocks script vectors; **allows `data:image/*` in `src` only**;
  - rendered in `components/inbox/message-thread.tsx`: emails as full-width
    cards whose body lives in a **sandboxed iframe**
    (`components/inbox/email-html-frame.tsx`, `sandbox` WITHOUT
    `allow-scripts` — never add `allow-scripts`, `allow-same-origin` is present
    for height measurement + authed same-origin image loads). Chat channels
    keep the bubble layout.
- **Reply**: `components/inbox/compose-reply.tsx` → `app/api/inbox/reply/route.ts`.
  Plain-text reply with proper `In-Reply-To`/`References` + `threadId`,
  Gmail-style quoted history of the last message (capped 10k chars,
  best-effort), base64 CTE (UTF-8 safe), sent **through the mailbox being
  viewed** (`mailbox` param — thread IDs are mailbox-scoped; support@ is the
  default).
- **Compose / forward**: `compose-dialog.tsx` → `app/api/inbox/compose/route.ts`
  → `sendEmail` (`lib/operations/email.ts`) — brand shell, duplicate check,
  tracking, CRM linkage.
- **Actions**: `app/api/inbox/email-actions/route.ts` (archive/trash/star/
  mark-unread/move-to-label/set_color, single + bulk, mailbox-aware).
  `app/api/inbox/mark-read/route.ts` removes UNREAD per message on open.
- **Color marks**: `lib/inbox/color-marks.ts`. A mark is a Gmail label named
  `Marked/<Color>` on the thread (created on first use; per-mailbox; one color
  per thread — `set_color` removes the other `Marked/*` labels). The
  conversations route maps mark label IDs → `colorMark` on each row; the list
  shows a colored dot + left edge, the thread header has the palette picker.
  No DB storage — the mark lives in Gmail and is visible/filterable there too.
- **Unread badges**: `app/api/inbox/stats/route.ts` returns
  `{ gmail, whatsapp, total }` (support@ INBOX unread + messaging groups).
  Consumed by `inbox-header.tsx` and the dashboard `unread-messages.tsx` card
  (reads `total`). Sidebar folder counts come from `app/api/inbox/labels` —
  Gmail's `labels.list` does NOT return counts, so the route calls
  `labels.get` per shown label (mailbox-aware; badge uses `threadsUnread`).
- **Bulk bar** (checkbox selection): Delete / Archive / Mark Read /
  Mark Unread / Move to folder — all via `email-actions` bulk branch.
- **Portal Chats email surface** (Phase 3, 2026-07-08): per-client GREEN dot +
  "Email" tab in `/portal-chats`. `app/api/portal-chats/email-unread` buckets
  support@'s unread inbox threads per account/contact
  (`lib/inbox/email-unread.ts`, same shape as the What's New purple counts;
  dot colors: red=chat, purple=What's New, green=email).
  `app/api/portal-chats/client-emails` lists a client's Gmail threads (all
  mail to/from their contact addresses); the tab's thread view REUSES the
  inbox `MessageThread`/`ComposeReply` (support@ mailbox), so opening an
  email marks it read in Gmail and the green dot clears naturally.
- **Real-time push** (Phase 3b, 2026-07-08): Gmail `users.watch` (INBOX, both
  mailboxes) publishes to Pub/Sub topic `gmail-push` in GCP project
  `claude-gmail-connector-488713`; the push subscription `gmail-push-sub`
  POSTs to `/api/webhooks/gmail-push` with a Google-signed OIDC token
  (audience = the endpoint URL; verified in `lib/gmail-push.ts::verifyPushOidc`
  — fails closed, no shared secrets). The webhook inserts a wake-up row in
  `gmail_push_events` (no email content); `inbox-shell.tsx` and the
  portal-chats page subscribe via supabase_realtime and refetch. Watches
  expire ~7 days → `app/api/cron/gmail-watch-renew` (daily 05:00) re-registers
  both watches, re-syncs the subscription endpoint, and prunes events >2 days.
  PROD-ONLY: the cron self-skips under `SANDBOX_MODE=1` and sandbox blocks
  `/api/webhooks/*`; the 5-min `email-monitor` cron and the 30s/60s polls stay
  as the delivery safety net. Watch state in `gmail_watch_state`
  (migration `20260708-2100-gmail-push-events.sql`).
  `components/dashboard/cards/email-intelligence.tsx` +
  `app/api/crm/email-intelligence/route.ts` (AI triage of unread, support@
  only), `app/api/cron/email-monitor/` (every 5 min: emails from contacts tied
  to open tasks → `agent_decisions` proposals).

## Access control

- `/inbox` and `/api/inbox/*` require a dashboard user (middleware); clients
  and partners are blocked entirely.
- **antonio@ is Antonio's PERSONAL mailbox — admin only** (2026-07-08 audit:
  it was readable by any team login before). Enforced SERVER-SIDE in every
  route that accepts `mailbox` via `checkMailboxAccess`
  (`lib/inbox/mailbox-access.ts`); the UI toggle is additionally hidden for
  non-admins (`app/(dashboard)/inbox/page.tsx` passes
  `canUsePersonalMailbox`). Any NEW inbox route that accepts a `mailbox`
  parameter MUST call `checkMailboxAccess` first — hiding UI is not a
  security boundary.

## Rules / gotchas

- **Thread and message IDs are per-mailbox.** Any Gmail API call for a thread
  listed under mailbox X must impersonate X (`asUser`). The UI passes
  `mailbox=antonio|support` end-to-end (list → thread → attachment → reply →
  actions → mark-read).
- **Gmail label index lags 30–60s** after modify operations — the UI papers over
  this with optimistic cache updates, `localStorage` deleted-ids (5-min TTL),
  and delayed invalidations. Don't "fix" those without understanding this.
- **Email HTML is attacker-controlled** (anyone can email support@). Defense in
  depth is sanitize + sandboxed iframe. Never render inbound email HTML with
  `dangerouslySetInnerHTML` outside the sanitizer, and never add
  `allow-scripts` to the frame.
- Notification-style senders (Stripe, ShipStation, banks…) can be threaded
  together **by Gmail itself** (same sender + subject) — that part is
  Gmail-side behaviour, not our code.
- **One view = one Gmail thread.** The subject-based "related thread merging"
  (added `c7afbe79`, guard `106ada77`) was REMOVED 2026-07-07: Gmail `subject:`
  search is contains-match, so same-sender notifications and templated
  subjects merged threads across clients. Do not reintroduce display-time
  merging — if outbound senders fragment a conversation, fix the sender to
  pass `reply_to_message_id` / proper `In-Reply-To`.
- Known debt (audit 2026-07-07): email→account lookup is last-write-wins for
  contacts on multiple accounts; 30s polling refetches up to ~200 threads +
  the whole `account_contacts` table.

## How to verify current state

1. `npm run test:unit -- email-html html-escape gmail` — parsing/sanitizer/cid
   rewrite invariants.
2. Sandbox deploy (`vercel deploy --yes` from the worktree, project
   `td-operations-sandbox`), log in as QA admin, open `/inbox`:
   an email with a pasted screenshot must show the image; an email with a
   data-URI signature image must show it; a large marketing email must render
   un-truncated inside its frame; switch to antonio@ and send a test reply.
3. Sends are blocked in sandbox (`SANDBOX_MODE`) — verify reply payloads via
   the API response / unit level; real-send QA happens on production only after
   explicit approval.
