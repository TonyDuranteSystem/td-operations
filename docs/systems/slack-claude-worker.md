# Slack Claude Worker

**Subsystem:** `slack-claude-worker`
**Last verified against code:** 2026-06-11 (ack-collapse + image support + thread-history images + file_share thread replies + message-ts dedup + image-validity guard + text-only fallback)
**Owned by:** Antonio Durante LLC — dev

---

## What it does

Always-on Claude presence in Slack. When Antonio writes `@Claude` in any Slack channel or thread, Claude responds conversationally — discuss, investigate, propose — without requiring an open Claude Code session.

**Key behaviors:**
- Immediate "On it 👍" ACK within 1–2 s (Slack's 3-second requirement met every time)
- AI reply 8–15 s later via the worker cron — the worker **morphs the "On it 👍" message in place** (`chat.update`) into the real answer instead of posting a second message, so the thread shows one message that transforms. Falls back to a fresh post if the ack ts is missing or the update fails (message too old/deleted).
- **Image attachments**: screenshots attached to a mention are downloaded by the worker (bot token) and passed to sonnet as base64 image blocks (vision). An image-only message (no caption) is accepted. If the current message carries no image but it's a **thread reply**, the worker pulls images from recent **thread history** (`conversations.replies`) — so "read the screenshot" works when the screenshot was posted earlier in the thread. Unsupported media types (HEIC/SVG/BMP) and files >5 MB are skipped; text still answered. See "Image attachments" below.
- Conversational tone (2–5 lines), discuss-before-act, never unilaterally mutates
- Conversation continuity: same channel/thread within 30 min → same `thread_id`
- Accepts `app_mention` events **and** plain thread-reply `message` events in a thread Claude already participated in (no @mention needed to keep a conversation going)

---

## Architecture

```
Slack                          Production server              Supabase
──────          ──────────────────────────────────           ────────
@Claude    →    /api/webhooks/slack-claude             →     INSERT agent_messages
                │  1. verify HMAC-SHA256 signature               (status=pending,
                │  2. URL challenge (one-time setup)              sender='slack',
                │  3. skip bots (loop protection)                 recipient='claude',
                │  4. dup guard: event_id THEN message-ts         context_json={…})
                │  5. POST "On it 👍" to Slack         ←  Slack
                │  6. findOrCreateConversationThread
                │  7. INSERT agent_messages row
                └→ fire POST /api/cron/slack-claude-worker?message_id=X  (2.5 s timeout)

/api/cron/slack-claude-worker (*/2 * * * *)
   Direct mode (POST + ?message_id):
     claimPending (UPDATE WHERE status='pending' RETURNING) → processSlackEvent
   Scan mode (GET):
     recoverStaleClaims (processing rows > 10 min) → pick ≤5 pending Slack rows
```

---

## Key files

| File | Role |
|------|------|
| `lib/ai-agent/slack-claude.ts` | Core module: `SLACK_WORKER_SYSTEM_PROMPT`, `slackScopeKey`, `postSlackMessage`, `findOrCreateConversationThread`, `processSlackEvent`, `prepareSlackImages`, `fetchThreadImages` (thread-history image harvest) |
| `app/api/webhooks/slack-claude/route.ts` | Slack Events API webhook handler |
| `app/api/cron/slack-claude-worker/route.ts` | Worker cron (direct trigger + scan safety net) |
| `scripts/migrations/20260610-1400-slack-claude-party.sql` | Adds `'slack'` to `agent_message_party` enum |
| `tests/unit/slack-claude-worker.test.ts` | Unit tests |

---

## DB tables

| Table | Usage |
|-------|-------|
| `agent_messages` | One row per Slack mention. `sender='slack'`, `recipient='claude'`, `context_json.source='slack'`. Status lifecycle: `pending → processing → done / failed`. |
| `thread_summaries` | One row per conversation scope. Created by `findOrCreateConversationThread` when a new 30-min window opens. |

### context_json keys on agent_messages rows

```json
{
  "source": "slack",
  "slack_event_id": "Ev01234ABC",
  "slack_channel_id": "C0BAB08DSDN",
  "slack_thread_ts": "1234567890.000100",
  "slack_event_ts": "1234567890.000200",
  "slack_scope_key": "C0BAB08DSDN:1234567890.000100",
  "slack_user_id": "U0ANTONIO",
  "slack_ack_ts": "1234567890.000300",
  "slack_images": [{ "url": "https://files.slack.com/…", "name": "screenshot.png", "mimetype": "image/png", "size": 84211 }]
}
```

- `slack_ack_ts` — ts of the "On it 👍" message; the worker `chat.update`s this into the final answer. `null` if the ack post failed → worker posts a fresh reply.
- `slack_images` — supported image attachments (filtered to `image/jpeg|png|gif|webp`, ≤5 MB) the webhook saw. `url` is Slack's `url_private`, fetched by the worker with the bot token (NOT in the webhook — downloading there risks the 3 s ACK). `[]` when none.

---

## Env vars required

| Var | Where | What |
|-----|-------|------|
| `SLACK_BOT_TOKEN_CLAUDE` | Vercel (both envs) | Bot OAuth token for the Claude Slack app (`A0B9LUJRLMB`), starts with `xoxb-` |
| `SLACK_SIGNING_SECRET_CLAUDE` | Vercel (both envs) | Signing secret from Slack app Basic Information page — used for HMAC request verification |
| `CRON_SECRET` | Vercel (both envs) | Shared secret for webhook → cron direct-trigger auth (same as hermes-bridge) |

**Never commit these to git.**

---

## Accepted events

The webhook processes:
- `app_mention` — Antonio @mentions Claude (any channel/context)
- `message` events that are (a) inside a thread (`thread_ts` set), (b) have **no** `subtype` **or** `subtype="file_share"` (genuine human text, or a pure screenshot drop with no @mention — Slack tags file uploads as `file_share`; all other subtypes `bot_message`/`message_changed`/`message_deleted`/joins are still excluded so edits/deletes/joins don't re-trigger), and (c) belong to a thread where Claude already participated (an `agent_messages` row exists with `context_json.source='slack'` and matching thread-level **or** channel-level `slack_scope_key`). Without the participation check Claude would answer every message in every thread in the channel.

All other event types are ACK'd with `{ ok: true }` and ignored.

## Duplicate-event protection (two layers)

Slack can deliver more than one event for a single underlying message, so the webhook dedups twice before inserting an `agent_messages` row:

1. **By `event_id`** (`isDuplicateEvent`) — catches Slack's own 3-second retry of the *same* event (same `event_id`).
2. **By message ts** — catches the case where Slack fires **two different events for the same message**: when Antonio @mentions Claude in a thread Claude already joined, Slack sends both an `app_mention` **and** a `message` event with *different* `event_id`s but the *same* `event.ts`. The event_id layer misses this (two distinct ids); the ts layer matches on `context_json->>slack_event_ts` + `slack_channel_id`, so whichever event arrives first inserts and the second is dropped (`{ ok: true, dedup: "message_ts" }`). Without it, one @mention produced a double "On it 👍" and double processing.

> Both layers are SELECT-then-INSERT with no DB unique constraint, so a true simultaneous race could still slip two rows through — Slack delivers the paired events sequentially, so this mitigates the real-world case. A unique index is the hardening option if doubles ever reappear.

## Image attachments

- **Webhook** (`route.ts`): reads `event.files`, keeps only `image/jpeg|png|gif|webp` within the 5 MB cap (`SLACK_SUPPORTED_IMAGE_TYPES` / `SLACK_MAX_IMAGE_BYTES` in `slack-claude.ts`), stores `{url,name,mimetype,size}[]` as `context_json.slack_images`. The text guard is relaxed to accept a message with **text OR ≥1 image**, so an image-only screenshot isn't dropped. Image-only body falls back to `"(image attached — no caption)"`. The thread-reply gate accepts `subtype="file_share"` so a pure screenshot dropped into a thread (no @mention) is processed rather than silently ignored.
- **Worker — current message** (`prepareSlackImages` in `slack-claude.ts`): downloads each url_private with `SLACK_BOT_TOKEN_CLAUDE`, **validates the downloaded bytes are a real image via magic-byte check** (PNG `89 50`, JPEG `FF D8`, GIF `47 49`, WEBP `"WEBP"` at offset 8), re-checks the 5 MB cap on the actual bytes, base64-encodes, returns `WorkerImageBlock[]`. Best-effort: a bad type / **non-image body (e.g. an HTML login page returned with a 200 when the bot lacks `files:read`)** / oversize / 401 / missing token skips that one image (logged), the reply still goes out. The magic-byte guard is what stops a login-page HTML blob from being base64'd and crashing the whole Anthropic call.
- **Worker — text-only fallback** (`processSlackEvent` in `slack-claude.ts`): the `callWorker` call is wrapped in try/catch. If it throws an **image-related 400** (error message contains both `400` and `image`, and images were attached), the worker retries **once without images** so Antonio still gets a text answer instead of a silent failure. Any other error (non-image, or no images attached) is re-thrown unchanged so the cron marks the row `failed` as before. This is the backstop for an image that slips past the magic-byte guard or an edge media type the API rejects at call time.
- **Worker — thread history fallback** (`fetchThreadImages` in `slack-claude.ts`): when `context_json.slack_images` is empty **and** the row is a thread reply (`slack_thread_ts` set), the worker calls `conversations.replies` (≤20 messages) and harvests any supported images from earlier in the thread, then feeds them through `prepareSlackImages`. This is what makes "read the screenshot" work when the screenshot was posted in a prior message. Best-effort: missing token / non-ok response (e.g. missing `channels:history` scope) / network error returns `[]` and the worker answers text-only. **Requires the bot to hold `channels:history` (and `groups:history` for private channels) read scope** — verify in prod E2E.
- **callWorker** (`worker-tools.ts`): `opts.images` is optional. When non-empty the user turn is sent as `[{type:"text",…}, …imageBlocks]`; otherwise a plain string — identical to the Hermes/Telegram path. `runWorkerLoop` accepts `string | content[]`.

## Loop protection

The webhook handler skips incoming events (runs **before** the participation query and insert) when:
- `event.bot_id` is set (any bot) — this is what stops Claude's own posted replies (which carry `bot_id`) from re-triggering
- `event.user === "U0B9S675WTT"` (Claude's own user ID)
- `event.subtype === "bot_message"`

---

## Conversation scope logic

`slackScopeKey(channelId, threadTs)`:
- Top-level message → key = `channelId`
- Threaded reply → key = `channelId:threadTs`

`findOrCreateConversationThread(channelId, threadTs)`:
1. Query `agent_messages` where `created_at > now - 30 min` AND `thread_id IS NOT NULL`
2. **First pass** — exact match on `context_json.slack_scope_key`
3. **Second pass** (only when `threadTs` is set) — match the channel-level scope (`channelId` with no thread_ts) that started the conversation. This is the fix for the channel→thread key drift: a channel-level mention stores `scope_key = channelId`, but its follow-up reply arrives with `thread_ts` set (`scope_key = channelId:thread_ts`). Prefer the channel-level row whose `slack_event_ts === threadTs` (exact thread-origin link); otherwise fall back to the most recent channel-level row in the window.
4. If found in either pass → reuse that `thread_id` (conversation continuity)
5. If not → generate new UUID, call `createThreadSummary`, return it

> **Edge case:** the channel-only fallback (no exact ts match) picks the *most recent* channel-level row. Two separate channel-level conversations in the same channel within 30 min, then a reply in the older one with no precise ts match, could attach to the newer conversation's memory. Bounded by the 30-min window and serial 1:1 usage.

---

## System prompt

`SLACK_WORKER_SYSTEM_PROMPT` in `lib/ai-agent/slack-claude.ts`:
- Short, conversational (2–5 lines max)
- Discuss-before-act: report findings, ask what to do next, never self-approve actions
- `propose_action` pattern: describe in plain English → wait for explicit approval ("yes", "go", "send it")
- Differs from `WORKER_SYSTEM_PROMPT` (Hermes): less analytical, more interactive

---

## Sandbox constraint

`SANDBOX_MODE=1` blocks `/api/webhooks/*` (middleware.ts:114). The Slack app Event Subscription URL **must** point to production (`https://td-operations.vercel.app/api/webhooks/slack-claude`). The worker cron is **not** blocked and can be tested independently:

```bash
curl -X POST "https://td-operations-sandbox.vercel.app/api/cron/slack-claude-worker?message_id=<UUID>" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## Slack app setup (one-time)

1. Go to api.slack.com/apps → `A0B9LUJRLMB` (Claude)
2. **Basic Information → Signing Secret** → copy → add as `SLACK_SIGNING_SECRET_CLAUDE` in Vercel
3. **Event Subscriptions** → enable → Request URL: `https://td-operations.vercel.app/api/webhooks/slack-claude`
4. Subscribe to bot events: `app_mention` **and** `message.channels` (the latter is required for thread-reply follow-ups without an @mention)
5. Save and reinstall app if prompted

---

## How to verify current state

```bash
# 1. Check migration was applied
# (sandbox)
psql $SANDBOX_DATABASE_URL -c "SELECT unnest(enum_range(NULL::agent_message_party));"
# Should include 'slack'

# 2. Check cron is registered
grep slack-claude-worker vercel.json

# 3. Check env vars are set (Vercel)
vercel env ls production | grep SLACK

# 4. Simulate a worker run (no real Slack needed)
curl -X POST "https://td-operations-sandbox.vercel.app/api/cron/slack-claude-worker" \
  -H "Authorization: Bearer $CRON_SECRET"
# → { "ok": true, "mode": "scan", "recovered": 0, "processed": 0 }

# 5. End-to-end: mention @Claude in #td-dev → expect "On it 👍" reply within 2s
```

---

## Related subsystems

- [`agent-bridge.md`](agent-bridge.md) — Hermes ↔ Claude bridge (same `agent_messages` table, same `callWorker` pattern)
- [`hooks-guardrails.md`](hooks-guardrails.md) — Sandbox enforcement (SANDBOX_MODE blocks `/api/webhooks/*`)
