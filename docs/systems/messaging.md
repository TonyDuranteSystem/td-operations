# Messaging (WhatsApp / Telegram)
_Last verified against code: 2026-09-24 — Claude (NEW: self-hosted WhatsApp link, provider `wabridge`, receive-only pilot in SANDBOX — see "Self-hosted bridge" below; dev job `907b2535`). Earlier 2026-09-23 note: Claude (Doc-only correction: the "Worker (AI-assist) stays Gmail/Telegram-only until WhatsApp has its own reviewed assist flow" line below is no longer true for WhatsApp — that flow now exists as a read-only Worker panel that hands drafts to the message box (dev job `6668385e`; full detail in `docs/systems/inbox.md` 2026-09-23). The email Worker and the CRM quick-create buttons remain Gmail/Telegram-only. Live production facts checked the same day: 173 active WhatsApp chats — 8 groups (`@g.us`, all `group_type='support_group'`), 115 with no lead/contact/company link, 20 lead-linked, 38 contact-linked, 1 company-linked; only 3 outbound WhatsApp messages exist in total, all since 2026-09-17 (the reply route was broken before that).)_
_Prior: 2026-09-19 — Claude (New file, small: `lib/messaging/search-match.ts::matchesWhatsAppSearch` — a pure name-or-phone-digit matcher backing a new Inbox WhatsApp search box. Full detail, the WhatsApp badge/Telegram-mislabeling bug it shipped alongside, and the Telegram-has-no-tab gap found while investigating are in `docs/systems/inbox.md` (2026-09-19), the doc that owns the touched UI/route files (`app/api/inbox/stats/route.ts`, `components/inbox/inbox-shell.tsx`, `components/inbox/conversation-list.tsx`) — noted here only because this doc's own path glob (`lib/messaging/`) matches the one new file. Test: `tests/unit/messaging-search-match.test.ts`.)_
_Prior: 2026-09-18e — Claude (**REAL BUG: OPENING A WHATSAPP CONVERSATION NEVER MARKED IT READ. dev job f331cd43.** Antonio: "the number of unread and read doesn't work" — the WhatsApp tab badge showed 228 (later confirmed live: 223, `sum(unread_count)` across 26 conversations, `max` 37 on a single one) while the visible list looked almost entirely read. Root cause, found by comparing the two thread components directly: Gmail's `message-thread.tsx` calls `/api/inbox/mark-read` the moment a conversation opens; `whatsapp-thread.tsx` never called anything — the row's own "mark read" icon (2026-09-18c) was the ONLY way a WhatsApp conversation's `unread_count` ever reached 0. The double-digit counts on old (March/April) conversations were genuine backlog that had simply never been touched by that path. **Fix:** `whatsapp-thread.tsx` now calls the same dedicated route the row icon already uses (`app/api/inbox/whatsapp/mark-read`) the moment a conversation opens, and invalidates both the conversation list and the tab-badge stats so the change reflects instantly with no reload. **Same race guard as Gmail's equivalent, applied because this fix makes it newly possible for WhatsApp too:** the row's own "mark unread" toggle (`conversation-list.tsx`) now awaits `openMarkReadSettled` before writing, so a fast reopen-then-mark-unread can't have the open-time auto-read land second and silently undo it — the identical incident already fixed for Gmail's header button (2026-08-05), reusing the same shared utility (`lib/inbox/pending-mark-read.ts`) rather than inventing a second one. **Verified live**, locally, against a disposable test conversation seeded with `unread_count=5`: confirmed the value directly in the database before opening it, opened it, and confirmed it read `0` immediately after with no page reload; confirmed the Inbox's own live stats endpoint reflected the drop the same way. **Deliberately not actioned in this pass:** the existing ~223-message backlog across 26 real conversations — some of it may be genuinely unread messages Antonio never saw, so zeroing it in bulk is his call, not something to assume; flagged to him as a separate decision. No new automated test — both changes are UI-wiring inside components (a `useEffect` firing a fetch, and one `await` guarding a mutation), and this project has no jsdom dependency to render-test a component the way `tests/unit/whatsapp-create-record.test.ts` tests a route; covered by the live verification above instead, same precedent as the two other UI-only fixes this session. Full suite green (11,252 tests, unchanged — no new automated coverage added), build clean.)_
_Prior: 2026-09-18d — Claude (**BULK "FIND MATCHING CLIENTS" SWEEP + PHONE-MATCHING TIGHTENED TO EXACT FULL-NUMBER. dev job f331cd43.** Antonio: "can now the system read all chats and check if the current numbers belongs to active client and save them and update their profile" — then, once the sweep surfaced a real duplicate-number pair, corrected the matching rule itself: "the entire number mst match not only some digits." **Rule change (affects the single-conversation banner too):** `findContactByPhone` (`lib/messaging/contact-match.ts`) used to accept any candidate sharing the caller's last 8 digits — real risk once more than one country is involved, since two different national numbers can share 8 trailing digits by coincidence. It now still queries with a last-8 `ilike` (cheap candidate narrowing, not the decision) but only accepts a candidate whose FULL digit string equals the target's. **New bulk sweep** (`POST /api/inbox/whatsapp/backfill-matches`, staff-triggered — a button, not a background job): scans every WhatsApp conversation with no lead/contact yet, matches each against every lead/contact's phone (and a contact's `phone_2`) using the same exact-full-number rule via a pure, unit-tested classifier (`lib/messaging/backfill-matches.ts::classifyGroups`). A conversation with exactly one match is linked immediately (phone filled only if currently blank, matching the single-conversation attach flow's own rule); a conversation matching 2+ different records is left alone — that means the EXACT SAME full number really does exist on more than one CRM record, which needs a human, not a guess. **Real find during this exact rollout, in production:** the sweep flagged one number matching a contact named "Uccio Durante" (his own internal test contact, `is_test=false` but an internal placeholder in practice) and a real client, Christian Pozza — Antonio confirmed live which one was real and it was linked manually; a second flagged pair (a lead and a contact both named Pietro Dalmaso, same number) is the harmless, expected case of a lead that was never marked converted after becoming a real contact. **Resolving an ambiguous match** reuses `/api/inbox/whatsapp-new/create-record`'s existing attach-to-contact branch, plus a new parallel `existingLeadId` branch for when one of the candidates is a lead. **UI:** `components/messaging/whatsapp-backfill-matches-dialog.tsx`, opened from a new "Find matching clients" button in the Inbox header (WhatsApp tab only, `inbox-shell.tsx`) — runs the sweep on open, shows a plain summary (N linked, with old-name → new-name lines) and, for each ambiguous case, a one-click picker among the real candidates. **Verified live** against a disposable three-conversation test (one clean match, one genuinely ambiguous two-contact collision, one with no match at all): the sweep linked the clean one and showed its new name immediately in the list with no page reload, correctly surfaced the ambiguous one with both real candidates, correctly resolved it on a click, and correctly left the no-match conversation untouched — confirmed directly against the database after each step, not just the UI. New tests: `tests/unit/messaging-backfill-matches.test.ts` (the pure classifier — single match, the real ambiguous-duplicate shape, last-8-only is rejected, no-phone/short-phone candidates ignored, multiple groups classified independently), `tests/unit/messaging-contact-match.test.ts` extended (a same-last-8-different-country pair is now correctly rejected, `phone_2` match still works), `tests/unit/whatsapp-create-record.test.ts` extended (the new `existingLeadId` attach branch). Full suite green (11,252 tests), build clean.)_
_Prior: 2026-09-18c — Claude (**REAL PRODUCTION BUG: "CONTACT OF AN EXISTING CLIENT" SILENTLY CREATED A DUPLICATE PERSON INSTEAD OF ATTACHING TO ONE WHO ALREADY EXISTED.** Antonio linked a WhatsApp number to Marinela Marku's real, already-existing contact under Numero Uno Social LLC — the flow found the company correctly, but `create-record`'s "contact" path (2026-09-17d) was INSERT-only: it always creates a new `contacts` row, with no way to say "it's her." Result, confirmed live in production: a second "Marinela Marku" contact was created with the WhatsApp phone, the real one (blank phone, from 2026-04-22) untouched — not a "phone didn't update" bug as it first looked, a silent duplicate-person bug. **Cleanup performed on the real record** (verified first that nothing but `messaging_groups` and `account_contacts` referenced the duplicate, checked across all 67 tables with a `contact_id` column): moved the phone onto the real contact (blank → safe to fill), repointed the WhatsApp conversation to it, deleted the duplicate's account link and the duplicate row itself. **Root-cause fix:** `whatsapp-contact-match-banner.tsx`, once an account is picked in the "Contact of an existing client" flow, now fetches that account's existing people (new `GET /api/inbox/whatsapp-new/account-contacts?accountId=`) and offers "Is this one of these people?" — picking one calls `create-record` in a new attach mode (`{ groupId, existingContactId, accountId }`) that links to the existing contact instead of inserting a new one, and fills the contact's phone ONLY if it is currently null — a contact who already has a real number is never overwritten (verified with a disposable test contact carrying a real number: the attach call left it untouched). No existing people at that account → the flow skips straight to the create-new form exactly as before, nothing changed for the genuinely-new-person case. New tests: `tests/unit/whatsapp-create-record.test.ts` (attach fills a blank phone and does not insert a new contact; attach never overwrites an existing phone; a bad existingContactId 404s; the ordinary create-new path is unaffected). Full suite green (11,239 tests), build clean. Verified live in the sandbox browser end-to-end: created a disposable test account with one existing contact, went through "Contact of an existing client" → the account → confirmed the existing person was offered and clicking it attached (not duplicated) and filled the blank phone; a second disposable contact with a real phone confirmed its number survived the same attach untouched. All test data deleted after.)_
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
  WhatsApp too, plus a WhatsApp-only read-only "Worker" panel (2026-09-23, see
  `docs/systems/inbox.md`); the email "Worker" and the CRM quick-create buttons
  stay Gmail/Telegram-only.

## Provider routing architecture
```
messaging_channels.provider = NULL       → error: "WhatsApp provider not configured"
messaging_channels.provider = 'twochat'  → sendVia2Chat() — LIVE
messaging_channels.provider = 'wabridge' → sendViaWabridge() — throws "not switched on yet" (receive-only pilot; CRM sends need the bridge outbox, a later phase)
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

## Self-hosted bridge (provider `wabridge`) — PILOT, sandbox only
Replaces the expired 2Chat subscription with our own linked-device program (GOWA, a
whatsmeow-based binary) running on the Mac Mini and linked to the owner's phone by QR
(WhatsApp "Linked devices"). **Unofficial, same risk class as 2Chat: a ban would hit the
linked number.** Nothing here sends automatically; the bridge only mirrors what the phone does.

```
phone <-WhatsApp-> GOWA (127.0.0.1:3001, launchd com.td.wa-bridge, ~/wa-bridge)
                     └─ HTTPS POST, HMAC-SHA256(body, channel.webhook_secret) ─→ /api/wa-bridge/[channelId]
                                                                                   └─ wabridge_ingest_message() SQL fn
```
- **Receiver** `app/api/wa-bridge/[channelId]/route.ts` (public prefix `/api/wa-bridge` in `middleware.ts`;
  deliberately NOT under `/api/webhooks`, which the sandbox guard 503s). Pure parsing + signature check in
  `lib/messaging/wabridge.ts`. 401 bad signature / 404 unknown or non-`wabridge` channel / 200 for anything
  intentionally ignored / 500 on a DB failure (GOWA retries a non-2xx 5× over ~30 s, then DROPS the event).
- **What is saved:** one-to-one chats whose `chat_id` is a phone JID (`<digits>@s.whatsapp.net`). Both directions:
  `is_from_me` = a message typed on the phone → outbound row (`status='responded'`, `metadata.sent_from='phone'`).
  `created_at` = WhatsApp's own timestamp (an outage catch-up keeps the true order). Text is stored as `text`
  (the 2Chat receiver stores plain text as `other`). Media has no caption → placeholder text (`[Photo]`, `[Voice note]`…);
  **media files are NOT stored yet** (auto-download is off).
- **What is dropped (200, nothing written):** groups (`@g.us`, also muted at GOWA), status/broadcast, newsletters,
  unresolved `@lid` chats (a fake phone number built from a LID would open a garbage, unreplyable thread), the owner's
  "message yourself" chat, reactions, receipts, edits, deletions, calls, presence.
- **Dedupe/atomicity:** `wabridge_ingest_message()` (migration `20260924-2200-wabridge-provider-and-ingest.sql`) inserts
  the message `ON CONFLICT DO NOTHING` on `external_message_id` and, only if it inserted, updates the conversation in the
  SAME transaction: inbound = unread+1 and revive a hidden chat; outbound = unread reset to 0, hidden chat stays hidden;
  `last_message_at` only moves forward. Dedupe is by WhatsApp message id ONLY (no text/time heuristic — it would swallow a
  legitimate second "ok").
- **Hardening in `run.sh`:** binds 127.0.0.1 with basic-auth, `--account-validation=false` (no "is this number on
  WhatsApp" lookups), `--auto-download-media=false`, `--mcp-enabled=false`, `--ui-auto-update=false`,
  `--presence-on-connect unavailable` (the phone keeps notifying), presence pulse off, `--webhook-events message`,
  `--webhook-ignore-jids @g.us` (NOT `@lid` — that wildcard would also drop LID-migrated events that GOWA resolved to a phone).
- **Secrets/config** live in `~/wa-bridge/bridge.env` (chmod 600): `CHANNEL_ID`, `WEBHOOK_SECRET`, `CRM_BASE_URL`, basic-auth.
  Switching the target CRM = change `CRM_BASE_URL`. Sandbox needs Vercel's automation-bypass query param (added by `run.sh`
  only when the URL contains `sandbox`).
- **Health alerting (GOWA emits NO connect/disconnect webhook):** `~/wa-bridge/heartbeat.sh` (launchd
  `com.td.wa-bridge-heartbeat`, every 60 s) reads GOWA's `/devices/td-crm/status` and POSTs a signed
  `{event:"bridge.heartbeat", ts, reachable, connected, logged_in}` to the same receiver URL. The receiver REQUIRES a fresh
  signed `ts` (±2 min — a captured beat cannot be replayed to hide an outage) and all three booleans, then records it in the
  bridge's OWN row `wa_bridge_state` via the atomic RPC `wabridge_record_heartbeat` (server clock; `bad_beats` counts
  consecutive unhealthy beats). `/api/cron/wa-bridge-watch` (every 5 min, `lib/messaging/wabridge-health.ts`, FAILS CLOSED
  when `CRON_SECRET` is unset) classifies it — `offline` (no heartbeat > 6 min: Mac off/asleep/no internet), `process_down`
  (Mac up, bridge dead), `unlinked` (`logged_in=false`: logged out / phone unused 14 days — immediate), `disconnected`
  (`connected=false` for ≥ 5 consecutive beats; a single reconnect blip is NOT an alarm) — and emails staff ONCE per problem
  via `sendDisconnectAlertEmail` (`alerted_state` marker written by `wabridge_set_alerted` BEFORE sending, cleared on
  recovery). Heartbeat, cron and ingest each write only their own columns/RPC — the earlier design shared one
  `config_json` blob and the writers overwrote each other (council finding 2026-09-24). A channel with no heartbeat yet is not
  monitored. Dropped `@lid` chats (a real person WhatsApp identified only by a hidden id) are COUNTED in
  `wa_bridge_state.dropped_lid_count`, never silent. The alert email HTML-escapes its inputs and takes a `hint`/`source`.
- **Names (Antonio 2026-09-24: never "Unknown"; phone and CRM names must agree):** `lib/messaging/chat-name.ts::resolveChatName`
  is what the Inbox list shows: linked CRM contact name > linked lead name > linked company name > the name saved on the phone
  (`messaging_groups.group_name`) > the formatted number `+<digits>`. Linked names are read live, so renaming a contact/lead in
  the CRM renames the chat at once. Phone → CRM: `~/wa-bridge/sync.mjs names` posts the phone's saved contact names
  (`bridge.names`) to `wabridge_apply_names`, which updates `group_name` for both key shapes (canonical `<digits>@c.us` and the
  legacy bare-digit keys), skipping empty / number-as-name entries. CRM → phone's address book is NOT possible (a linked device
  cannot write the phone's contacts; GOWA exposes no such endpoint) — the CRM name shows in the CRM instead.
- **History download + catch-up (`~/wa-bridge/sync.mjs`):** reads GOWA's LOCAL chat store (no WhatsApp traffic) and sends signed
  `bridge.backfill` batches (≤ 200 items). `backfill` = one-time history download: rows land as already-read/responded, change no
  unread and un-hide nothing, and a row that a LEGACY source (2Chat / the old import — `metadata.source ≠ 'wabridge'`) already
  stored for the same chat (same direction, same text — or same media kind — within 3 min) is skipped, because legacy ids differ
  from WhatsApp's and would otherwise duplicate every message 2Chat saved. `catchup` (`live:true`) re-sends the last N days as
  LIVE messages, so a message the live path missed (GOWA drops an event after ~31 s of CRM failure) still counts as unread.
  Everything dedupes on the WhatsApp message id, so both are safe to re-run. What the store holds is what the phone synced at
  pairing (measured 2026-09-24: 224 one-to-one chats, 552 messages — the most recent few per chat); older history would need
  per-chat on-demand requests to the phone (`POST /chat/:jid/history`), not built.
- **Automatic chat → lead/contact linking (2026-09-25, Antonio: "recognize the phone number, not Unknown … immediately").** Migration
  `20260925-0100-wabridge-auto-link.sql`: `wabridge_link_chat(group)` links ONE chat, `wabridge_link_unlinked(channel)` sweeps a channel and
  returns jsonb counts per outcome, `wabridge_names_agree(a,b)` / `wabridge_name_tokens(n)` are the name check. Rules (deliberately
  conservative — a wrong link puts a real person's messages under someone else's name): NEVER overwrite an existing lead/contact/account
  link; match on the FULL number (all digits equal, any stored format — the 2026-09-18 ruling, never last-N digits); exactly ONE person must
  match (a lead and the contact it was converted into, `leads.converted_to_contact_id`, are one person; two different people sharing a
  number = `ambiguous` = left for a human); test leads and merged contacts ignored. SECOND SIGNAL, the NAME (added after a sandbox check
  found 5 of 45 same-number links pointing at a person with a completely different name, and tightened after the bug-hunter review): when
  the chat carries a comparable name (the phone-saved name, or the sender's WhatsApp name), one name must be FULLY CONTAINED in the other,
  word for word — accents/case ignored, words under 3 letters ignored. "Barnabas" ⊂ "Barnabás Zahola" agrees; "Maria Rossi" vs "Marco Rossi"
  does NOT (a shared surname is not enough); a nickname like "Ste" vs "Stefano" does NOT (goes to a person); a disagreement = `mismatch` =
  left unlinked. A chat with NO comparable name on either side (null, "Unknown", just a number, non-Latin script such as Arabic, initials
  only) can only be matched on the number — allowed ONLY once the phone's names have been synced into that channel at least once
  (`wa_bridge_state.names_synced_at`, stamped by `wabridge_apply_names`) AND the chat is at least 3 minutes old, so a recycled number cannot be
  linked to its old owner in the window before the real name arrives; until then the outcome is `waiting`. Two triggers: (1) a LIVE message for
  a still-unlinked chat calls `wabridge_link_chat` inside the receiver's `ingest()` (best-effort, failures logged as a warning — it can never
  fail or delay the save; not run for history downloads); (2) `/api/cron/wa-bridge-link` (every minute, CRON_SECRET fail-closed) runs the sweep,
  which is what makes "I saved the number on the lead" take effect within about a minute WITHOUT a trigger on the core lead/contact tables. The
  cron logs the per-outcome counts (`linked` / `mismatch` / `ambiguous` / `waiting` / `none`) so held-back chats are visible in the cron log.
  Measured 2026-09-25 on the sandbox copy of the 180 real chats (one clean pass, then undone): 40 would link, 5 mismatch, 3 ambiguous, 132 have
  no CRM record with that number. A wrong link is undone by clearing the chat's link (existing link UI); the functions never touch a chat that
  already has one. NOT built: a staff-facing list of held-back chats and a "possible match by name" suggestion for CRM records with no phone
  number (needs UI); numbers stored without a country code (e.g. a 10-digit US number) or with a leading 0 do not match by design.
- **Names every minute:** `~/wa-bridge/names-cycle.sh` (launchd `com.td.wa-bridge-names`, 60 s) runs `sync.mjs names`, which reads the
  phone's saved names LOCALLY and only contacts the CRM when they changed (hash in `storages/names.hash`; `--force` bypasses it); the
  15-minute job keeps only the live-message catch-up. Scheduled jobs MUST be registered with `launchctl bootstrap gui/$UID <plist>` — jobs
  loaded with the legacy `launchctl load` from a tool shell showed `runs = 0 / uninitialized` and never fired (found 2026-09-24; the
  heartbeat and sync jobs had not been running on their own).
- **Production cutover runbook (rehearsed in sandbox 2026-09-24 — NOT yet run in production; each step needs Antonio's per-item "ship it"):**
  1. Merge the code and get a production deploy READY (auto-deploy from main is unreliable — verify, then `vercel deploy --prod` from a
     clean clone). Safe before the switch: the receiver 404s any channel that is not `provider='wabridge'` and the watchdog finds none.
  2. Antonio runs `scripts/migrations/20260924-2200-wabridge-provider-and-ingest.sql` in the Supabase SQL editor (one file: provider
     value, `wa_bridge_state`, the five `wabridge_*` functions).
  3. FIRST save the old 2Chat `webhook_secret` (rollback), then `UPDATE messaging_channels SET provider='wabridge', webhook_secret=<new>`
     on the Lead channel. Changing the secret also switches 2Chat's webhook OFF (it authenticates by secret → 401). 2Chat itself is then
     cancelled/left to lapse (Antonio: fully off).
  4. Repoint the Mac: `~/wa-bridge/bridge.env` `CRM_BASE_URL`/`CHANNEL_ID`/`WEBHOOK_SECRET` → production, restart the GOWA job
     (`launchctl kickstart -k gui/$(id -u)/com.td.wa-bridge`). Heartbeat + sync jobs read the same file.
  5. `node sync.mjs catchup --days 7` first (messages that arrived while 2Chat was dead count as UNREAD — that gap is the point), then
     `node sync.mjs backfill` and `names`.
  6. Verify: chat/message counts vs the phone store, no duplicates, no second thread for a legacy-keyed chat, names showing, one real
     inbound + one phone-typed reply captured. Rollback = set provider back to `twochat` + the saved secret.
  Rehearsal result (sandbox Lead channel seeded with legacy-style chats): the 20 messages a legacy source had already saved were
  skipped by the backfill duplicate guard, all other messages saved, per-chat totals matched the phone store exactly, no second thread was
  created for any bare-digit chat, a hidden legacy chat stayed hidden, unread stayed 0, and a live message joined the legacy thread.
- **Known gaps (deliberate, next phases):** the production cutover (Antonio runs the migration; switch the Lead channel from
  `twochat` to `wabridge`; turn 2Chat's webhook off; `findOrCreateWhatsAppGroup` looks up only the canonical `@c.us` key, so a chat
  that still has a legacy bare-digit key would get a SECOND thread — resolve before cutover), CRM-typed sends (signed pull outbox;
  reply-only; first contact stays on the phone), the Reconnect-from-CRM button, media/voice storage, delivery ticks, hide-chat
  button, disk encryption (FileVault is OFF — it and auto-login are mutually exclusive on macOS; auto-login is ON).
- **Existing bug noticed, not fixed here:** `dispatchWhatsAppMessage` writes `content_type: "media"` for attachments,
  which is not in the `messages_content_type_check` list — the insert error is swallowed, so outbound attachment copies are
  probably never saved.

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
