# Inbox (CRM unified inbox — Gmail + WhatsApp/Telegram)
_Last verified against code: 2026-07-09d — Claude (**List-row Read/Unread toggle + mobile-visible row actions** — Antonio follow-up to 2026-07-09c. Each Gmail row in `conversation-list.tsx` now has a Read/Unread toggle button NEXT TO the per-row Delete (trash) icon: `Mail` icon → `mark_read` when `conv.unread > 0`, `MailOpen` → `mark_unread` when read (`conv.unread` here is already override-applied at the display map). Uses a local `markMutation` that optimistically flips the badge via the parent's unread override (new `onUnreadOverride` prop, wired to `setUnreadOverrides` in `inbox-shell.tsx`) and invalidates ONLY stats/labels — NEVER the conversations list (the ~300-Gmail-call refetch is what blanked the inbox under load, 2026-07-08). Both row actions moved into one flex container with `opacity-100 sm:opacity-0 sm:group-hover:opacity-100` — **hover-reveal on desktop (≥640px), ALWAYS visible on mobile** (touch has no hover, so the actions were unreachable on Antonio's ~380px phone PWA). Browser E2E: toggle marks read/unread both directions with correct icon flip; desktop unhovered opacity confirmed 0, mobile-visible confirmed via the CSS breakpoint (base `opacity-100`, hide gated behind the ≥640px media query). **LIVE ON PRODUCTION** 2026-07-09.)_
_Prior 2026-07-09c — Claude (**Per-email Print/Save-as-PDF + Read/Unread toggle** — source: Luca Slack request. The open-email toolbar (`inbox-shell.tsx`, `isGmail` block, next to Delete) gained: (1) a **Print** button (Printer icon) → `printEmailThread` in `lib/inbox/print-email.ts`. `buildPrintDocument` (pure, unit-tested `tests/unit/print-email.test.ts`) builds a self-contained doc — escaped subject/sender headers + `sanitizeEmailHtml` bodies, plain-text bodies in `<pre>`, messages chronological (oldest-first, Gmail-print style) — and `printEmailThread` loads it into an OFF-SCREEN **sandboxed iframe** (`sandbox="allow-same-origin allow-modals"`, **NO `allow-scripts`** — same attacker-controlled-HTML invariant as `email-html-frame.tsx`; header fields are escaped because sender/subject are attacker-influenced) then calls `contentWindow.print()` from the parent (the parent's script triggers it, so the frame needs no scripting), giving a Gmail-style print/Save-as-PDF of the WHOLE thread incl. headers. The thread bodies live in `message-thread.tsx`, which registers the handler up to the toolbar via a new OPTIONAL `registerPrint` prop (the portal-chats reuse omits it, so it's unaffected). (2) a labeled **Read/Unread** toggle (`openUnread` = optimistic `unreadOverrides` else `row.unread` → `mark_read`/`mark_unread`); the pre-existing icon-only Mark-as-unread button is KEPT (Antonio: keep both). No DB/API changes. Sandbox browser E2E verified: Print fires `window.print()` and renders the doc in-sandbox (scripts absent), toggle marks unread + closes the thread + bumps the folder unread count. **LIVE ON PRODUCTION** 2026-07-09.)_
_Prior 2026-07-09b — Claude (**Share now embeds the full email text**: the header "Share" button is async — it fetches `/api/inbox/messages/<id>`, strips the email HTML to plain text (`stripEmailHtml` in `inbox-shell.tsx`) and passes it as the shared message body so the recipient sees the whole email, not just the snippet (capped at 4000 chars; bulk share stays snippet-only). Full detail in team-workspace.md → "Share to team chat".)_
_Prior 2026-07-09 — Claude (**Share button UX + inbox scroll fix** (sandbox, pending prod ship): (A) the per-thread share control is now a labeled emerald **"Share"** pill right after the Worker pill — was an unlabeled paper-plane buried between Link and Delete (undiscoverable). (B) the inbox no longer whole-page-scrolls on desktop: `app/(dashboard)/inbox/page.tsx` wraps `InboxShell` in `h-full lg:h-[calc(100%-3.5rem)] overflow-hidden` to subtract the sticky 56px desktop `DashboardHeader` that plain `h-full` didn't account for — list + open email now scroll internally within the viewport; mobile unchanged (header hidden there); mirrors the /portal-chats app-shell pattern.)_
_Prior 2026-07-08d — Claude (**Share to team chat**: `inbox-shell.tsx` gained a per-thread "Share to team chat" header button + a bulk "Share to team" button (multi-select → one message each) + a NEW inbox deep-link `/inbox?thread=gmail:<id>&mailbox=` hydrated from `window.location` on mount, so a shared email links back. Uses the shared `ShareToTeamDialog`; full detail in team-workspace.md → "Share to team chat". **LIVE ON PRODUCTION** 2026-07-09, commit `1a02c4ef`.)_
_Prior 2026-07-08c — Claude (cosmetic only, PWA mobile UX pass dev_task `e1f28dce`: the Gmail search-bar row and the bulk-action bar in `inbox-shell.tsx` gained `flex-wrap` so their buttons wrap below the input at phone width instead of overflowing. No behavior change.)_
_Prior 2026-07-08b — Claude (reply pipeline Gmail-parity: multipart HTML replies, RFC 2047 To-encoding, isHtml flag from real MIME type, quoted-text collapse, 4-row email composer with Enter=newline, post-send delayed refetches; earlier same day: inbox audit + rendering/threading/color-marks overhaul; responsive thread header)_

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
  Gmail `snippet`s are HTML-entity-encoded — previews go through
  `decodeHtmlEntities` and sender names through `displayNameFromHeader`
  (both `lib/inbox/email-html.ts`) before plain-text display.
- **Thread view**: `app/api/inbox/messages/[id]/route.ts` for `gmail:<threadId>`
  IDs fetches the full thread. Each message body:
  - extracted by `extractBodyWithType` (`lib/gmail.ts`) which also returns
    the REAL MIME type as `isHtml` on the message payload — the renderer
    branches on that flag, NOT on a content sniff ("contains < and >"
    misdetected plain replies quoting `<a@b.com>` as HTML and ate every
    line break, 2026-07-08). Plain-text emails render `whitespace-pre-wrap`
    with quoted history ("On ... wrote:" / "> " lines, EN+IT) collapsed
    behind a Gmail-style "Show quoted text" toggle (`splitQuotedText` in
    `lib/inbox/email-quote.ts`, unit-tested);
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
    keep the bubble layout. EMAIL threads render NEWEST-FIRST (Luca 2026-07-08) — chat channels stay chronological with bottom auto-scroll.
- **Reply**: `components/inbox/compose-reply.tsx` → `app/api/inbox/reply/route.ts`.
  Gmail-parity MIME built by the pure `buildReplyMime` in
  `lib/inbox/reply-mime.ts` (unit-tested): **multipart/alternative**
  (text/plain with "> "-quoted history + text/html with a `gmail_quote`
  blockquote), proper `In-Reply-To`/`References` + `threadId`, quoted
  history capped 10k chars (best-effort), base64 CTE, **RFC 2047-encoded
  Subject AND To display-name** (`encodeAddressHeader` in `lib/gmail.ts` —
  the Gmail API returns headers decoded; copying From→To raw shipped
  "TamÃƒÂ¡s" mojibake, 2026-07-08), sent **through the mailbox being
  viewed** (`mailbox` param — thread IDs are mailbox-scoped; support@ is the
  default). Composer (email mode): 4-row resize-y textarea, **Enter = new
  line, Cmd/Ctrl+Enter = send** (chat channels keep Enter-to-send); after a
  send the thread re-fetches at 0/4/12s because Gmail indexes the sent copy
  with a lag and the push watch covers INBOX only — without the delayed
  refetches the sent reply never appears until manual refresh.
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
- **Per-email toolbar Print + Read/Unread** (2026-07-09): the open-thread
  toolbar (`inbox-shell.tsx`, `isGmail` block) has a **Print/Save-as-PDF**
  button (`lib/inbox/print-email.ts`; off-screen sandboxed iframe, NO
  `allow-scripts`; `MessageThread` supplies the handler via the optional
  `registerPrint` prop) and a labeled **Read/Unread** toggle next to Delete
  (both the labeled toggle AND the older icon-only Mark-unread button exist —
  keep both). Print security invariant: NEVER render inbound email HTML for
  print in an un-sandboxed / same-origin window — the iframe sandbox is the
  boundary (see `print-email.ts` header comment).
- **List-row Read/Unread + mobile-visible actions** (2026-07-09):
  `conversation-list.tsx` shows a Read/Unread toggle next to each Gmail row's
  Delete icon (`markMutation` + parent `onUnreadOverride` for the optimistic
  badge; stats/labels invalidation only, no conversations refetch). The row
  action cluster is `opacity-100 sm:opacity-0 sm:group-hover:opacity-100` —
  hover-reveal ≥640px, always-on below (mobile touch has no hover). When adding
  more row actions, keep them in this same container so the mobile-visible /
  desktop-hover rule stays consistent.
- **Portal Chats email surface** (Phase 3, 2026-07-08): per-client GREEN dot +
  "Email" tab in `/portal-chats`. `app/api/portal-chats/email-unread` buckets
  support@'s unread inbox threads per account/contact
  (`lib/inbox/email-unread.ts`, same shape as the What's New purple counts;
  dot colors: red=chat, purple=What's New, green=email).
  `app/api/portal-chats/client-emails` lists a client's Gmail threads (all
  mail to/from their contact addresses); the tab's thread view REUSES the
  inbox `MessageThread`/`ComposeReply` (support@ mailbox), so opening an
  email marks it read in Gmail and the green dot clears naturally.
- **Email → client links** (2026-07-08): the thread header's Link2 button
  (`components/inbox/link-client-dialog.tsx` → `/api/inbox/email-links`)
  attaches ANY Gmail thread (ShipStation/Mercury-style notifications) to a
  CRM account. Table `email_links` (pre-existing, EXTENDED by migration
  `20260708-2300-email-links.sql`: + mailbox/contact_id/subject/sender and
  the previously-MISSING `uq_email_links_thread` unique index — the
  create-from-email dialog's upsert had silently failed forever without it).
  Targets EVERY role — accounts, contacts, LEADS, PARTNERS (`lead_id`/
  `partner_id` columns, migration `20260708-2340`; the
  `/api/inbox/link-targets` search sweeps all four tables and the dialog
  shows role badges). Thread-header buttons show hover legends
  (`components/inbox/hover-hint.tsx`).
  ONE link per thread; re-linking replaces the client. Linked threads merge
  into the client email views (`client-emails` endpoint, `linked: true`
  badge) — Portal Chats Email tab, the account page **Emails** tab, the
  account **Overview**'s compact Emails card
  (`components/accounts/account-emails-card.tsx`, "View all" → the tab) and
  the CONTACT page's **Emails** tab (`contact-detail.tsx`). The account view
  also includes links made to the account's CONTACTS (role-agnostic
  surfacing). The client views HIDE
  our own automated notification emails (portal digest + chat-notify
  subjects, `lib/inbox/system-email-filter.ts`; a deliberately linked one is
  kept) and classify each thread `received`/`sent` by the LAST message's
  sender — the panel has All/Received/Sent filter chips.
- **Worker panel** (2026-07-08, Antonio: "the same worker I have in Slack
  with the same power in inbox"): the thread header's **Worker** button
  (replaces the old AI Assist dispatch) opens
  `components/inbox/worker-chat-panel.tsx` → `POST /api/inbox/worker-chat`
  → `callWorker` with the SLACK persona + inbox surface override
  (`lib/ai-agent/inbox-worker-prompt.ts`) over shared read-only
  `WORKER_TOOLS` (+ memory recall + propose_action; Slack-only extras like
  send_portal_message / code-task rail are NOT included — R111 preserved).
  Conversation memory persists PER EMAIL THREAD via thread scope
  `inbox-<mailbox>-<gmailThreadId>` (hashed to a deterministic UUID for
  `agent_messages.thread_id` by `deterministicThreadUuid`; the readable
  scope is kept in `context_json.crm_scope_key`). Mailbox-gated
  (`checkMailboxAccess`); route `maxDuration = 300`. On the FIRST turn the
  route reads the thread itself (last 5 messages, plain text, capped) and
  hands the worker the transcript + the gmail thread id/mailbox for
  `gmail_read_thread` self-serve — the worker never claims it can't see the
  open email (best-effort: a Gmail hiccup degrades to snippet context).
  FULL SLACK PARITY (2026-07-08c): every exchange recorded in
  `agent_messages` (sender `crm` — enum value added by migration
  20260709-0200 — recipient `worker`: no cron claims recipient='worker',
  isolating these rows from the Slack + dormant Hermes-bridge queues; see
  ai-agent.md), so pronouns work
  across turns and GET on the route restores the conversation on panel
  reopen; Slack read rails enabled (SQL dig-in, sysdocs/SOPs/Drive, calls,
  Calendly, client threads, thread recall, web-search dark) with
  maxIterations 20. The SAME route also
  serves a CLIENT MODE (`clientKey: acct-<id>|contact-<id>`, thread scope
  `chat-<clientKey>`, portal-chats surface prompt) — used by the Portal
  Chats **Worker** tab (`components/portal-chats/thread-worker-panel.tsx`),
  per-client persistent memory.
  **SEND RAIL (2026-07-08d, Antonio: "the same powerful worker I have in
  Slack — when I say 'send it' it must send")**: the CRM worker now SENDS,
  scoped per surface so a screen can only send through its natural channel:
  Inbox → `enableEmailSend` (email reply, threaded in the open Gmail thread);
  Portal Chats → `enableSlackSend` (portal-chat message). The code-task rail
  stays OFF (Antonio-only, R111); everything non-send still routes through
  `propose_action`. Two safety additions over the raw Slack behavior, both in
  `worker-tools.ts` via the new `WorkerSendContext` threaded
  callWorker→runWorkerLoop→executeWorkerTool: (1) **hard-pinned recipient** —
  the Portal Chats send is FORCED to the open client (`pinnedPortalRecipient`
  from `clientKey`); the executor overrides whatever ids the model supplies,
  so it can NEVER message another client; (2) **per-staff attribution** —
  every send is logged to `action_log` with `sendActor`
  (`crm-inbox:<email>` / `crm-portal:<email>`) instead of the generic worker
  actor. The send tools remain OUT of `WORKER_TOOLS` (injected only via the
  enable flags), so the dormant Hermes worker is unaffected (R108). Sending
  still requires the staff member's explicit "send it" (prompt discipline in
  the surface addenda, generalized from "Antonio" to "the staff member here"
  since all staff can send). Sandbox blocks real email (`SANDBOX_MODE`) — email
  send is verified there by payload only; portal-message send is fully testable.
  Tests: `tests/unit/slack-portal-send.test.ts` (pin override, actor attribution),
  `tests/unit/inbox-worker-prompt.test.ts` (per-surface send authorization).
- **Degradation contract** (2026-07-09): a Gmail fetch failure in
  `/api/inbox/conversations` returns **503** for the gmail-only view (merged
  view returns the chat channels + `gmailDegraded: true`) and the list's
  queryFn throws on non-2xx — react-query then KEEPS the previous list
  instead of replacing it with "No conversations" (the old 200-with-empty
  behavior blanked the inbox whenever Gmail rate-limited us). Push-driven
  invalidations are debounced 2.5s trailing: bulk archive/delete of N
  emails fires N push events; without the debounce that meant N
  back-to-back full refetches (each up to ~300 Gmail calls) → 429 → blank.
- **Anti-blank hardening** (2026-07-09, after Antonio reported the list
  vanishing on mark-unread / scroll while the prod re-backfill was running):
  (1) the conversations query uses `placeholderData: keepPreviousData` — the
  list never flashes empty during a refetch or a mailbox/filter switch;
  (2) mark_read / mark_unread (single AND bulk) NO LONGER force a
  conversations refetch — the optimistic unread override already flips the
  badge, so a ~300-Gmail-call refetch per read-toggle (the thing that
  blanked the list under load) is gone; only membership-changing actions
  (trash/archive/move) refetch; (3) the email-index backfill cron
  (`/api/cron/email-index-sync`) PAUSES during US business hours (13:00–23:00
  UTC) and does at most ONE page/run otherwise — the one-time rebuild makes
  ~180 live Gmail calls/page on the SAME mailbox the inbox reads, and running
  it hard mid-day starved Gmail's per-user quota (3s list loads + hiccups).
  The rebuild just finishes overnight; index-backed surfaces fall back to
  live Gmail until `backfill_done`, so pausing has zero correctness cost.
  KNOWN heaviness (future work): the default INBOX list still does ~300 live
  Gmail metadata GETs per load — it should read from `email_index` like
  search/client-emails/green-dots already do.
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

- **Email index** (leg 1, 2026-07-08, dev_task 224726be): `email_index` —
  metadata-only, REBUILDABLE cache of both mailboxes (one row per message:
  headers, snippet, label state, resolved CRM linkage; NO bodies/attachments;
  tsvector `search` column; migration `20260709-0100`). Gmail stays the
  source of truth — wipe & rebuild on drift. Fed by (a) resumable backfill +
  reconcile cron `/api/cron/email-index-sync` (*/10 min; cursors in
  `gmail_watch_state.backfill_page_token/index_history_id`) and (b) the
  gmail-push webhook (incremental `syncIncremental` per notification,
  best-effort). Engine: `lib/email-index/sync.ts`. RLS: staff read;
  antonio@ rows ADMIN-ONLY (mirrors `checkMailboxAccess`).
- **Email index — leg 2 surfaces** (2026-07-09, dev_task 224726be): query
  layer `lib/email-index/query.ts` (pure grouping unit-tested). Rows carry
  `label_ids text[]` (raw Gmail labelIds; migration `20260709-0300` — added
  mid-backfill, so it WIPES the index and restarts the backfill; labels are
  what let the index exclude TRASH/SPAM, scope the green dot to in:inbox
  parity, detect DRAFT threads, and resolve Marked/* color labels). Three
  consumers, each gated on `isBackfillDone(mailbox)` AND falling back to the
  live-Gmail path on any index error — index serving is never worse than
  live: (a) **instant search** in `/api/inbox/conversations`: plain-word
  queries (no Gmail operators — `isInstantSearchQuery`) answer from the
  tsvector index in ~ms; operator queries (`from:`, `has:` …), label views
  and pagination stay live; (b) **client email cards**
  (`/api/portal-chats/client-emails`): thread ids from
  `clientEmailThreadIds` (two indexed queries — from_email in-list +
  to_emails array-overlap; deliberately NOT a PostgREST `or(in.(),ov.{})`,
  whose quoting silently breaks) + linked threads, grouped by
  `groupRowsToConversations`, same system-notification noise rule; (c)
  **green dots** (`/api/portal-chats/email-unread`):
  `unreadInboxExternalEmails` (UNREAD+INBOX rows → full-thread externals)
  feeding the unchanged `bucketUnreadEmails`.

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
