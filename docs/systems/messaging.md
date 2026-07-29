# Messaging (WhatsApp / Telegram)
_Last verified against code: 2026-07-29 — Claude (inbox staff-gate sweep, dev job 7e63fcd2: the WhatsApp inbox routes — `app/api/inbox/new-whatsapp`, `app/api/inbox/whatsapp/conversations`, `app/api/inbox/whatsapp/messages/[groupId]` — now call `requireStaffRoute()` first-line. They previously relied only on middleware's "is logged in", which a portal client satisfies; group listings and message history were readable by any logged-in account. No behavior change for staff.)_
_Prior: 2026-06-23 — periskope-cleanup branch_

## What it is
A legacy WhatsApp/Telegram inbox stored in Supabase. Staff can read messages and send
WhatsApp messages via MCP tools. The system is **provider-agnostic by design**: the
outbound send layer reads `messaging_channels.provider` at runtime and dispatches to
the appropriate handler — adding a new provider requires one DB row change and one
handler function, nothing else.

Currently **no provider is configured** (Periskope was removed 2026-06-23). All send
calls will return a clear error until a supported provider (`meta` or `twilio`) is
wired up in `messaging_channels`.

## Tables
- `messaging_channels` — one row per WhatsApp number or Telegram bot. Key columns:
  - `platform` (`'whatsapp'` | `'telegram'`) — the channel type
  - `provider` (nullable text) — the send provider (`'meta'`, `'twilio'`, or NULL = not connected)
  - `config_json` (jsonb) — provider-specific config (API keys etc.)
  - `is_active` boolean
- `messaging_groups` — one row per WhatsApp group/contact thread
- `messages` — all inbound + outbound messages

## Key files
- `lib/mcp/tools/messaging.ts` — MCP tools: `msg_inbox`, `msg_read_group`, `msg_search`,
  `msg_send`, `msg_mark_read`, `msg_list_channels`
- `lib/messaging/send-dispatcher.ts` — provider routing layer. Reads `provider` from
  `messaging_channels`, dispatches to handler; returns `{ ok: false, error }` for NULL /
  unknown provider
- `app/api/inbox/new-whatsapp/route.ts` — REST endpoint: find/create a WhatsApp
  messaging_group for a contact and send the first message

## Provider routing architecture
```
messaging_channels.provider = NULL     → error: "WhatsApp provider not configured"
messaging_channels.provider = 'meta'   → sendViaMeta() stub (TODO: implement)
messaging_channels.provider = 'twilio' → sendViaTwilio() stub (TODO: implement)
unknown provider string                → error: "Unknown WhatsApp provider ..."
```
`dispatchWhatsAppMessage(chatId, message, channelId)` in `send-dispatcher.ts` is the
single entry point for all outbound WhatsApp sends.

## Gotchas
- `messaging_channels.platform` is the column that holds `'whatsapp'`/`'telegram'`.
  There is NO `channel_type` column — a historical bug used that wrong name and was
  fixed in the periskope-cleanup migration (2026-06-23).
- `provider` was previously `NOT NULL`; the 2026-06-23 migration drops that constraint
  so NULL means "no provider configured" (not an error at DB level, but at routing level).
- The old `send-message` Supabase Edge Function no longer exists in this repo.

## How to verify current state
- Schema: `SELECT platform, provider, is_active FROM messaging_channels;`
- No Periskope references: `grep -ri "periskope" lib/ app/ --include="*.ts"` → should be empty
- Column name: `SELECT column_name FROM information_schema.columns WHERE table_name='messaging_channels' AND column_name='platform';`
- Unit tests: `npx vitest run tests/unit/messaging-dispatcher.test.ts`
