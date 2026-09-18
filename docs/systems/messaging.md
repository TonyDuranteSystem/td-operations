# Messaging (WhatsApp / Telegram)
_Last verified against code: 2026-09-18c — Claude (**REAL PRODUCTION BUG: "CONTACT OF AN EXISTING CLIENT" SILENTLY CREATED A DUPLICATE PERSON INSTEAD OF ATTACHING TO ONE WHO ALREADY EXISTED.** Antonio linked a WhatsApp number to Marinela Marku's real, already-existing contact under Numero Uno Social LLC — the flow found the company correctly, but `create-record`'s "contact" path (2026-09-17d) was INSERT-only: it always creates a new `contacts` row, with no way to say "it's her." Result, confirmed live in production: a second "Marinela Marku" contact was created with the WhatsApp phone, the real one (blank phone, from 2026-04-22) untouched — not a "phone didn't update" bug as it first looked, a silent duplicate-person bug. **Cleanup performed on the real record** (verified first that nothing but `messaging_groups` and `account_contacts` referenced the duplicate, checked across all 67 tables with a `contact_id` column): moved the phone onto the real contact (blank → safe to fill), repointed the WhatsApp conversation to it, deleted the duplicate's account link and the duplicate row itself. **Root-cause fix:** `whatsapp-contact-match-banner.tsx`, once an account is picked in the "Contact of an existing client" flow, now fetches that account's existing people (new `GET /api/inbox/whatsapp-new/account-contacts?accountId=`) and offers "Is this one of these people?" — picking one calls `create-record` in a new attach mode (`{ groupId, existingContactId, accountId }`) that links to the existing contact instead of inserting a new one, and fills the contact's phone ONLY if it is currently null — a contact who already has a real number is never overwritten (verified with a disposable test contact carrying a real number: the attach call left it untouched). No existing people at that account → the flow skips straight to the create-new form exactly as before, nothing changed for the genuinely-new-person case. New tests: `tests/unit/whatsapp-create-record.test.ts` (attach fills a blank phone and does not insert a new contact; attach never overwrites an existing phone; a bad existingContactId 404s; the ordinary create-new path is unaffected). Full suite green (11,239 tests), build clean. Verified live in the sandbox browser end-to-end: created a disposable test account with one existing contact, went through "Contact of an existing client" → the account → confirmed the existing person was offered and clicking it attached (not duplicated) and filled the blank phone; a second disposable contact with a real phone confirmed its number survived the same attach untouched. All test data deleted after.)_
_Prior: 2026-09-18b — Claude (Bug-hunter finding, fixed same session: `findOrCreateWhatsAppGroup` (`lib/messaging/groups.ts`) finds/reuses an existing group with no `is_active` awareness — a hidden (deleted, see `inbox.md`) group's inbound webhook handler now also sets `is_active: true` on every genuinely new inbound message, so a client texting back after their conversation was deleted becomes visible again instead of staying permanently hidden. `msg_list_channels` in `lib/mcp/tools/messaging.ts` had the same unfiltered-sum bug for its group/unread totals — fixed alongside. `msg_inbox`'s backing view (`v_messaging_inbox`) already filtered `is_active` correctly — checked its live definition, needed no change. Full detail and the companion dashboard-badge fix in `docs/systems/inbox.md` (2026-09-18c), same split as other Inbox-UI-vs-messaging-pipeline entries below.)_
_Prior: 2026-09-18 — Claude (Three new routes under `app/api/inbox/whatsapp/` — `pin`, `mark-read`, `delete` — each a single `messaging_groups` column update backing the Inbox's row hover-actions (pin/mark-unread/delete-with-undo). Pure Inbox UI feature, not a messaging-pipeline change; full detail in `docs/systems/inbox.md` (2026-09-18b), same split as the contact-match entry below.)_
_Prior: 2026-09-17b — Claude (Added `lib/messaging/contact-match.ts::findContactByPhone` — looks up whether a WhatsApp number already has a CRM record (a lead, or a contact with/without a linked client account), matching on the last 8 digits for tolerance against inconsistent phone formatting, same rule `lead_create`'s own duplicate check already uses. Read-only; the write side (creating the record Antonio chooses) lives in the Inbox's own API route, documented in `docs/systems/inbox.md` (2026-09-17d) since it's specifically an Inbox UI feature, not a messaging-pipeline concern.)_
_Prior: 2026-09-17 — Claude (2Chat.co WhatsApp provider, dev job f331cd43: registered a real `twochat` handler in the dispatcher, fixed the Inbox reply route — it was calling a Supabase Edge Function that no longer exists, so every WhatsApp reply through the UI failed regardless of provider — un-hid the reply box for WhatsApp threads, added a shared canonical-key group lookup (`lib/messaging/groups.ts`) to stop the historical-import vs. new-conversation `external_group_id` formats from forking a returning contact's history, added the inbound webhook receiver + a disconnected-number email alert, and added a uniqueness constraint on `messages.external_message_id` so a redelivered webhook can't double-insert. Live-verified in the browser against a seeded sandbox conversation, including a real call to 2Chat's own API. Scope as approved: ONE number (the existing Lead channel), not the Office/Support channel — Antonio explicitly ruled out reconnecting WhatsApp as a full conversation channel for existing clients, only occasional one-off nudges from the same number.)_
_Prior: 2026-07-29 — inbox staff-gate sweep, dev job 7e63fcd2_
_Prior: 2026-06-23 — periskope-cleanup branch_

## What it is
A WhatsApp/Telegram inbox stored in Supabase. Staff read and reply to WhatsApp threads
from the CRM Inbox; an inbound webhook receives new messages. The system is
**provider-agnostic by design**: the outbound send layer reads
`messaging_channels.provider` at runtime and dispatches to the matching handler —
adding a new provider is one DB row + one handler function, nothing else.

**2Chat.co is the live provider today**, connected via their "QR-code" mode (an
existing personal/business WhatsApp number linked as a companion device — NOT the
official Meta Business API). One number is wired: the Lead channel. Meta/Twilio
remain unimplemented stubs.

## Tables
- `messaging_channels` — one row per WhatsApp number or Telegram bot. Key columns:
  - `platform` (`'whatsapp'` | `'telegram'`) — the channel type
  - `provider` (nullable text) — `'twochat'`, `'wassenger'`, `'telegram_bot_api'`,
    `'meta'`, `'twilio'`, or NULL = not connected. Widened to include `'twochat'` by
    migration `20260917-1500-messaging-channels-add-twochat-provider.sql`.
  - `webhook_secret` (nullable text) — the shared secret this channel's inbound
    webhook URL must be called with (`?secret=...`). NULL = the webhook rejects
    everything for that channel (fail-closed, not "no check").
  - `config_json` (jsonb) — **non-secret** per-channel config only. The 2Chat API key
    is an environment variable (`TWOCHAT_API_KEY`), NOT a column value — `msg_list_channels`
    returns `config_json` verbatim to any MCP caller, and this table already has one
    documented near-miss (`lib/ai-agent/tool-risk.ts`) from exactly that pattern.
  - `is_active` boolean
- `messaging_groups` — one row per WhatsApp/Telegram thread. `external_group_id` is
  the canonical key — see "Conversation-key format" below. Unique on
  `(channel_id, external_group_id)`.
- `messages` — all inbound + outbound messages. `external_message_id` is now UNIQUE
  (migration `20260917-1600-messages-external-message-id-unique.sql`, NULLs excepted)
  so a redelivered inbound webhook can't create a duplicate row.

## Key files
- `lib/mcp/tools/messaging.ts` — MCP tools: `msg_inbox`, `msg_read_group`, `msg_search`,
  `msg_send`, `msg_mark_read`, `msg_list_channels`
- `lib/messaging/send-dispatcher.ts` — provider routing layer. Reads `provider` from
  `messaging_channels`, dispatches to handler; returns `{ ok: false, error }` for NULL /
  unknown provider. `sendVia2Chat()` is the live handler — calls
  `https://api.p.2chat.io/open/whatsapp/send-message` with `X-User-API-Key: $TWOCHAT_API_KEY`.
- `lib/messaging/phone.ts` — `digitsOnly` / `toWhatsAppJid` / `jidToE164`. THE
  canonical phone-format helpers — any code touching a WhatsApp identifier should
  use these rather than re-deriving digits/format itself.
- `lib/messaging/groups.ts` — `findOrCreateWhatsAppGroup()`. THE canonical
  conversation lookup — always keys on `toWhatsAppJid(remoteIdentifier)` and upserts
  on the `(channel_id, external_group_id)` unique index. Used by both the outbound
  "New WhatsApp" flow and the inbound webhook so they can never disagree on which
  thread a given number belongs to.
- `lib/messaging/disconnect-alert.ts` — `sendDisconnectAlertEmail()`. A WhatsApp
  disconnect is a system/infra event with no client to scope it to, so it does NOT
  go through the To-Do board's `emitActionNeeded()` (every `ActEvent` there requires
  a contact/account id) — it's a direct staff email instead, same pattern as the
  workflow SLA escalation email.
- `app/api/inbox/new-whatsapp/route.ts` — REST endpoint: find/create a WhatsApp
  messaging_group for a contact and send the first message. Also fixed this pass:
  it previously inserted a `participant_count` column that doesn't exist in the
  schema (would have thrown on every first-time conversation) and looked up an
  existing group by `external_group_id` alone, with no `channel_id` scope.
- `app/api/inbox/reply/route.ts` — the Inbox panel's reply-to-an-existing-conversation
  endpoint. WhatsApp now branches to `dispatchWhatsAppMessage()`; Telegram's branch
  (still the old Edge-Function call) is untouched and out of this job's scope.
- `app/api/webhooks/2chat/[channelId]/route.ts` — inbound webhook receiver. See below.
- `components/inbox/whatsapp-thread.tsx` — the WhatsApp thread view. No longer
  read-only: has its own compose bar (Enter to send, Shift+Enter for a newline,
  matching `compose-reply.tsx`'s convention for chat channels).
- `components/inbox/inbox-shell.tsx` — the "Reply" header button is now shown for
  WhatsApp too; "Worker" (AI-assist) and the CRM quick-create buttons stay
  Gmail/Telegram-only until WhatsApp has its own reviewed assist flow.

## Provider routing architecture
```
messaging_channels.provider = NULL       → error: "WhatsApp provider not configured"
messaging_channels.provider = 'twochat'  → sendVia2Chat() — LIVE
messaging_channels.provider = 'meta'     → sendViaMeta() stub (TODO: implement)
messaging_channels.provider = 'twilio'   → sendViaTwilio() stub (TODO: implement)
unknown provider string                  → error: "Unknown WhatsApp provider ..."
```
`dispatchWhatsAppMessage(chatId, message, channelId)` in `send-dispatcher.ts` is the
single entry point for all outbound WhatsApp sends — `app/api/inbox/reply` and
`app/api/inbox/new-whatsapp` both go through it now (the reply route did not,
before this pass — see Gotchas).

## Conversation-key format
**Canonical: `${digits}@c.us`** (`toWhatsAppJid()`), the same shape the "New
WhatsApp" flow always used. The historical WA_Export import wrote a bare digit
string instead — two different keys for the same real number, so a contact with
imported history got a second, empty thread the first time someone messaged them
through the app. `findOrCreateWhatsAppGroup()` is now the only way either the
outbound flow or the inbound webhook creates/finds a group, so no third format can
appear. **NOT YET DONE:** a one-time backfill normalizing the ~169 existing
production Lead-channel groups (still in the old bare-digit format) to the
canonical shape — this touches real historical client/lead data and needs
Antonio's explicit go separately from the code, not bundled into a routine deploy.

## Inbound webhook
`POST /api/webhooks/2chat/[channelId]?secret=<messaging_channels.webhook_secret>`
- One URL per connected channel — the channel comes from the URL, never trusted
  from the payload's `channel_phone_number` (attacker-controlled like the rest of
  the body).
- **Fail-closed auth**: 2Chat's API doesn't document a request-signing scheme, so
  the secret embedded in the URL registered with 2Chat is the only proof of origin.
  A channel with `webhook_secret IS NULL` accepts nothing — deliberately the
  stricter of this codebase's two existing webhook-auth patterns (Stripe/Whop),
  not the "warn and process anyway" one (Relay/Banking Circle).
- Payload with an `event` field (`disconnected`, `qr-received`, `message.read`) is a
  status-change event — `disconnected` triggers the staff email alert; the others are
  acknowledged only.
- Payload without `event` is a message. `sent_by: "agent"` is our own outbound send
  echoed back (already recorded when we sent it) and is skipped. `sent_by: "user"`
  is genuinely inbound — written via `findOrCreateWhatsAppGroup()` + an insert into
  `messages`; a `23505` (unique-violation) on that insert means 2Chat redelivered a
  message we already have — treated as a successful dedup, not an error.
- **Registering the actual webhook** (subscribing this URL + a fresh per-channel
  secret with 2Chat) is a manual step done once per number, from 2Chat's own
  dashboard/API, at connection time — not automated by this codebase.

## Outbound pacing (2Chat ban-avoidance guidance)
2Chat's own published guidance: pace bulk/programmatic sending to ~1 message per 5
minutes (max ~12/hour) to avoid the number being flagged; a brand-new number should
also be "warmed up" first (does not apply to the Lead number — real message history
back to 2025-09-28, confirmed live). **Deliberately NOT implemented as a rate
limiter in this pass**: today's only send paths are one-at-a-time, human-triggered
replies (Inbox reply, "New WhatsApp") — the pacing rule is about BULK sending to
MANY recipients, which no feature in this codebase does yet. Throttling every
manual reply to one per 5 minutes would break ordinary conversation for a risk that
doesn't exist yet. **This becomes a hard requirement, not optional, the moment any
bulk/multi-recipient WhatsApp send feature is built** (e.g. a "notify several
clients" campaign) — add the limiter there, scoped to that feature, not retrofitted
onto manual replies.

## Gotchas
- `messaging_channels.platform` is the column that holds `'whatsapp'`/`'telegram'`.
  There is NO `channel_type` column — a historical bug used that wrong name and was
  fixed in the periskope-cleanup migration (2026-06-23).
- `provider` was previously `NOT NULL`; the 2026-06-23 migration drops that constraint
  so NULL means "no provider configured" (not an error at DB level, but at routing level).
- **The Inbox's reply-to-an-existing-conversation route did NOT use the provider
  dispatcher until 2026-09-17** — it called `${SUPABASE_URL}/functions/v1/send-message`,
  a Supabase Edge Function whose source no longer exists anywhere in this repo (confirmed
  by a repo-wide search, not just this doc's earlier claim). Every WhatsApp reply
  through the Inbox UI failed, independent of which provider was configured, until
  this was fixed. Telegram's branch of that same route still calls the dead
  function — untouched, out of this job's scope, and likely has the same defect;
  flagged, not fixed here.
- Only ONE WhatsApp number is wired (Lead). If a second/third number is ever
  activated simultaneously, `msg_send`'s and `new-whatsapp`'s "default active
  channel" queries have no deterministic tiebreak beyond `created_at ASC` (added
  this pass) — fine for one active row, worth a real per-purpose default before a
  second one goes live.
- `messaging_channels.config_json` is documented above this table as "provider
  config (API keys etc.)" in an OLDER version of this same doc — that was wrong even
  then and is corrected now: secrets are environment variables, never this column.

## How to verify current state
- Live provider + secret: `SELECT platform, provider, is_active, webhook_secret IS NOT NULL AS has_secret FROM messaging_channels;`
- No Periskope references: `grep -ri "periskope" lib/ app/ --include="*.ts"` → should be empty (still true)
- Provider enum includes 2Chat: `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='messaging_channels'::regclass AND contype='c';`
- external_message_id uniqueness: `SELECT conname FROM pg_constraint WHERE conrelid='messages'::regclass AND contype='u';`
- Unit tests: `npx vitest run tests/unit/messaging-dispatcher.test.ts tests/unit/messaging-phone.test.ts tests/unit/messaging-groups.test.ts tests/unit/messaging-disconnect-alert.test.ts tests/unit/webhooks-2chat.test.ts`
