# Slack Claude Worker

**Subsystem:** `slack-claude-worker`
**Last verified against code:** 2026-06-15 (TWO GEARS investigation upgrade: the Slack worker now has a QUICK vs DIG-IN prompt — dig-in triggers on investigate/check/diagnose/"why" and restores verify-and-trace discipline (verify each claim, trace behaviour in the code instead of guessing from a column/flag, devil's-advocate, Confirmed/Unconfirmed hand-off for Claude Code) + a hardened read-only `run_sql_query` tool (single-statement SELECT/WITH only, write/DDL blocklist, `auth`+token+password tables blocked, audit-logged, Slack-gated via `enableDbRead`) + `maxIterations` raised to 12 — see "Investigation gear (dig-in)"; prior: 2026-06-13 Slack worker can SEND portal chat messages directly via the new `send_portal_message` tool — Slack-only, no confirmation code, gated by `enableSlackSend` and kept OUT of the shared `WORKER_TOOLS` so the Hermes research worker never gets a client-send tool (R108); fixes Claude proposing an email when Antonio said "send it" on a portal-chat draft — see "Portal-chat send rail"; + code-task progress updates: the Mac Mini runner now posts "🔧 picked it up" right after claiming a code task + one-shot 5-min/10-min "still running" heartbeats around the `claude --print` session, cleared on settle; the queueing Slack worker can't track progress because it runs in a 300 s-capped serverless function that dies on return — see "Code-task rail"; + animated "thinking" indicator: the "On it 👍" ack cycles "🔍 Looking into it…" every 3 s while the worker runs, preserving the Stop button, stopping the moment the row leaves `processing`; on a genuine worker failure the ack is no longer left frozen on the last animation frame — it morphs to "⚠️ Something went wrong on my end — try again or rephrase." with the Stop button dropped, skipped only if the row was already `cancelled` so the "⏹ Stopped" notice is preserved, then the error re-throws so the cron still marks the row `failed`; answer now posts as a NEW thread message for a Slack push notification — ack collapses to "✅" instead of morphing in place; Stop button: "On it 👍" ack now carries a "⏹ Stop" button; new `/api/webhooks/slack-interactions` route cancels the in-flight message; + thread-reply invitation gate: parent-message @mention check replaces channel-level participation query — Claude no longer barges into threads he was never invited to; + ack-collapse + image support + thread-history images + file_share thread replies + message-ts dedup + image-validity guard + text-only fallback + code-task rail auto-push + SHIPPING prompt + shared-thread text context so Claude sees Hermes's messages)
**Owned by:** Antonio Durante LLC — dev

---

## What it does

Always-on Claude presence in Slack. When Antonio writes `@Claude` in any Slack channel or thread, Claude responds conversationally — discuss, investigate, propose — without requiring an open Claude Code session.

**Key behaviors:**
- Immediate "On it 👍" ACK within 1–2 s (Slack's 3-second requirement met every time)
- AI reply 8–15 s later via the worker cron — the worker **posts the answer as a NEW message** (`chat.postMessage`) in the thread, then collapses the "On it 👍" ack to a minimal "✅" (`chat.update`, `blocks: []` to drop the Stop button). A fresh post is what triggers a Slack **push notification** so Antonio knows on his phone that Claude finished — `chat.update` is an edit and Slack does not notify on edits (which is why the old in-place "morph" left him with no signal). Order is post-first: if the fresh post fails (channel error), the worker falls back to morphing the ack into the answer so the reply is never lost.
- **Image attachments**: screenshots attached to a mention are downloaded by the worker (bot token) and passed to sonnet as base64 image blocks (vision). An image-only message (no caption) is accepted. If the current message carries no image but it's a **thread reply**, the worker pulls images from recent **thread history** (`conversations.replies`) — so "read the screenshot" works when the screenshot was posted earlier in the thread. Unsupported media types (HEIC/SVG/BMP) and files >5 MB are skipped; text still answered. See "Image attachments" below.
- Conversational tone (2–5 lines), discuss-before-act, never unilaterally mutates
- Conversation continuity: same channel/thread within 30 min → same `thread_id`
- Accepts `app_mention` events **and** thread-reply `message` events, but a thread reply is only processed if Claude was **invited to that specific thread** — the reply @mentions Claude, or (for a plain reply) the thread's **parent message** @mentioned Claude. A plain reply in someone else's thread (e.g. a Hermes-only thread) is skipped.

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
| `lib/ai-agent/slack-claude.ts` | Core module: `SLACK_WORKER_SYSTEM_PROMPT`, `slackScopeKey`, `postSlackMessage`, `updateSlackMessage`, `findOrCreateConversationThread`, `processSlackEvent`, `prepareSlackImages`, `fetchThreadImages` (thread-history image harvest), `fetchThreadHistory` (thread-history **text** harvest for shared-thread context), `buildThinkingBlocks` / `verifySlackSignature` / `parseSlackInteraction` / `STOP_THINKING_ACTION_ID` (Stop button) |
| `app/api/webhooks/slack-claude/route.ts` | Slack Events API webhook handler (posts the "On it 👍" ack with the Stop button) |
| `app/api/webhooks/slack-interactions/route.ts` | Slack interactive-components webhook — handles the "⏹ Stop" button click |
| `app/api/cron/slack-claude-worker/route.ts` | Worker cron (direct trigger + scan safety net) |
| `scripts/mac-mini/code-task-runner.mjs` | Mac Mini launchd daemon: claims `recipient='code_runner'` rows, posts "🔧 picked it up" + live tool-activity milestones + 5/10-min heartbeats, runs headless `claude --print --output-format stream-json --verbose`, auto-pushes new commits to production, posts result to the Slack thread |
| `scripts/mac-mini/code-task-progress.mjs` | Pure stream-json parser used by the runner: maps assistant `tool_use` events → coarse Slack milestones (editing / building / testing / committing), and reads the final answer + `is_error` flag from the terminal `result` event. Unit-tested in `tests/unit/code-task-progress.test.ts` |
| `scripts/mac-mini/ask-antonio.mjs` | CLI the headless session runs to ask Antonio a blocking question in Slack and wait for his reply (the ask-antonio loop). Inserts a `code_task_questions` row, posts the question, polls until answered/expired |
| `scripts/mac-mini/ask-antonio-lib.mjs` | Pure helpers for the ask-antonio CLI (Slack text format, answer cleaning, poll-row interpretation, Antonio's user id). Unit-tested in `tests/unit/ask-antonio-lib.test.ts` |
| `scripts/migrations/20260610-1400-slack-claude-party.sql` | Adds `'slack'` to `agent_message_party` enum |
| `tests/unit/slack-claude-worker.test.ts` | Unit tests |

---

## DB tables

| Table | Usage |
|-------|-------|
| `agent_messages` | One row per Slack mention. `sender='slack'`, `recipient='claude'`, `context_json.source='slack'`. Status lifecycle: `pending → processing → done / failed`. |
| `thread_summaries` | One row per conversation scope. Created by `findOrCreateConversationThread` when a new 30-min window opens. |
| `code_task_questions` | One row per ask-antonio question (`pending → answered / expired`). Written by the ask-antonio CLI (insert + poll), answered by the Slack webhook (Antonio's thread reply), expired by the runner on task settle. Migration `scripts/migrations/20260612-1900-code-task-questions.sql`. |

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
- `app_mention` — Antonio @mentions Claude (any channel/context). Always processed.
- `message` events that are (a) inside a thread (`thread_ts` set), (b) have **no** `subtype` **or** `subtype="file_share"` (genuine human text, or a pure screenshot drop with no @mention — Slack tags file uploads as `file_share`; all other subtypes `bot_message`/`message_changed`/`message_deleted`/joins are still excluded so edits/deletes/joins don't re-trigger), **and** (c) pass the **thread-reply invitation gate** below.

### Thread-reply invitation gate (`route.ts`, the `isThreadReply && !isAppMention` block)

A thread reply is only processed if Claude was actually invited to **that specific thread**. Three cases, in order:

1. The reply itself @mentions Claude (`<@U0B9S675WTT>`) → **process** (explicit).
2. The reply @mentions someone else but **not** Claude (e.g. `@Hermes`) → **skip** (`directed_at_other`).
3. The reply has **no** @mention at all → fetch the thread's **parent (root) message** via `conversations.history?latest=<thread_ts>&inclusive=true&limit=1` and process **only if the parent text contains `<@U0B9S675WTT>`**; otherwise the thread belongs to someone else → **skip** (`not_invited`). Parent-fetch failure (missing token/scope, network, not found) defaults to skip — the safe default, since the bug being guarded is over-responding.

A top-level `@Claude` that opens a thread roots that thread at the mention message, so its later plain replies see parent-mention = true and continue the conversation. **Behavior change (2026-06-12):** the old gate used a channel-level participation query (`agent_messages` row with matching thread-level **or** bare `channelId` `slack_scope_key`). The bare-channel match leaked — once Claude had spoken at the top level of a channel, every plain reply in *any* thread of that channel matched and Claude barged in (notably Hermes-only threads). The parent-mention check scopes "invited" to the actual thread. Trade-off: if Claude was mentioned *mid-thread* of a non-Claude-rooted thread, a later *plain* reply is no longer answered — re-mention to continue.

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

## Shared-thread context (Claude sees Hermes's messages)

When Antonio tags **both** `@Claude` and `@Hermes` in a thread, the worker would otherwise only have `row.body` (the current message) + Claude's own `agent_messages` memory — it never sees what Hermes said. The fix injects the real Slack transcript:

- **`fetchThreadHistory(channelId, threadTs, limit=30)`** (`slack-claude.ts`): calls `conversations.replies` and formats each message as `Sender: text [+N file(s)]`. Skips Claude's own messages (user id `U0B9S675WTT` — already in its agent_messages context). Labels by user id: Antonio `U0BAALR4Y4Q`, Hermes `U0B9D3MAD9B`, any `bot_id` → `Bot`, else `Someone`. Rewrites `<@ID>` mention tokens to readable `@Claude`/`@Hermes`/`@Antonio`. Best-effort: missing token / non-ok response (e.g. missing `channels:history` scope) / network error → returns `""` and the worker uses `row.body` unchanged.
- **`processSlackEvent`** gates the fetch on the genuine thread ts (`context_json.slack_thread_ts`), same gate as the thread-image fallback — a brand-new top-level mention has no prior thread to read (and would fire a useless `conversations.replies` call). When history is non-empty the worker body becomes:
  ```
  [SLACK THREAD CONTEXT — what others said in this thread]
  Antonio: …
  Hermes: …

  [YOUR CURRENT MESSAGE]
  <row.body>
  ```
- **System prompt** carries a `SHARED THREADS` block telling Claude to read the context, not repeat what Hermes already answered, and — if Antonio says "send it" after Hermes drafted something — acknowledge Hermes already sent it rather than asking "to who?".
- Antonio's user id `U0BAALR4Y4Q` is **not otherwise referenced in code** (supplied by Antonio); a wrong id only degrades his label to `Someone`, never the flow. Claude `U0B9S675WTT` + Hermes `U0B9D3MAD9B` are cross-checked against `app/api/webhooks/slack-claude/route.ts`.
- **Requires the bot to hold `channels:history`** (and `groups:history` for private channels) read scope — same scope the thread-image fallback needs. Verify in prod E2E.

## Loop protection

The webhook handler skips incoming events (runs **before** the invitation gate and insert) when:
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
- **CODE TASKS** block: when asked to implement/build/fix/deploy → investigate with read tools, then call `start_code_task` with detailed instructions, then say "I've queued the task — Mac Mini will handle it and report back here"
- **SHIPPING** block: when Antonio says "ship it"/"deploy it"/"push it" → don't re-queue a done code task (the runner auto-pushes); if a local commit is waiting, say "The code is committed and being pushed to production"; "ship" = push to production, "do it" = implement — don't confuse the two
- **PORTAL CHAT REPLIES** block: to reply to a client in portal chat, after Antonio's explicit "send it", call `send_portal_message` (account_id for an LLC, or contact_id for a person) — it posts in the client's portal, NOT an email; never propose an email for a portal chat reply (see "Portal-chat send rail" below)
- **SHARED THREADS** block: read Hermes's messages from the injected thread context, don't repeat what Hermes already answered, acknowledge Hermes already sent something rather than asking "to who?" (see "Shared-thread context" above)
- Differs from `WORKER_SYSTEM_PROMPT` (Hermes): less analytical, more interactive
- **TWO GEARS** block (2026-06-15): QUICK (default — one lookup, 2–5 lines) vs DIG IN (triggered when Antonio asks to investigate/check/diagnose/audit or asks "why"). Dig-in tells the worker to chain as many read-only lookups as needed, use `run_sql_query` + `codebase_read`/`codebase_search` to **verify against the real data and trace how a feature behaves instead of guessing from a column/flag**, be its own devil's advocate, and end with a Confirmed / Unconfirmed hand-off so findings go straight to Claude Code. Plus a SENSITIVE DATA rule (never paste raw secrets/tokens/passwords into Slack). See "Investigation gear" below.

---

## Investigation gear (dig-in) + read-only SQL (`run_sql_query`)

Added 2026-06-15 after the Slack worker mis-diagnosed a client portal question — it guessed from a single DB column (`portal_account`) instead of tracing the switcher code, because its prompt told it to do the *minimum* lookup and it had no raw-DB access. Goal: a Slack client question can be investigated deeply enough that the findings are a trustworthy hand-off into Claude Code.

- **Two gears, prompt-driven.** `SLACK_WORKER_SYSTEM_PROMPT` now distinguishes QUICK (status/chitchat — one lookup, brief) from DIG IN (investigate/check/diagnose/"why"). Dig-in restores the verify-and-trace discipline the conversational prompt had dropped: verify every claim with a fresh tool call, trace behaviour in the code (`codebase_read`/`codebase_search`) rather than inferring from a column, be the devil's advocate, and label Confirmed vs Unconfirmed in the reply.
- **Read-only SQL tool.** `RUN_SQL_QUERY_TOOL` (`run_sql_query`) + `runReadOnlySqlForWorker()` in `lib/ai-agent/worker-tools.ts` reach data the canned `search_*` tools can't (e.g. `account_contacts` links, `ss4_applications`, `service_deliveries`, portal tier/flags). Hardened beyond the in-dashboard `runSqlQuery`: the pure validator `assertWorkerReadOnlySql` enforces **single statement only**, **SELECT/WITH only**, a **write/DDL keyword blocklist** (also catches write-CTEs), and **blocks the `auth` schema + token/password tables** (`auth.*`, `oauth_*`, `qb_tokens`, `push_subscriptions`, `encrypted_password`) so login hashes/tokens can never be read into a Slack reply. Every accepted query is audit-logged (`action_log`, actor `claude.slack`); output is capped (`WORKER_SQL_RESULT_CAP`).
- **Gating (R108 safety):** `run_sql_query` is **NOT** in the shared `WORKER_TOOLS`, so the Hermes/Telegram research worker never gets raw SQL. It is injected only when `CallWorkerOptions.enableDbRead` is true — set only by `processSlackEvent` (alongside `enableCodeTasks`/`enableSlackSend`). `executeWorkerTool` dispatches it before the read-only guard. Same gating pattern as `send_portal_message` / `start_code_task`.
- **Loop budget.** `processSlackEvent` raises `maxIterations` to 12 (from the default 8) so a real investigation isn't cut off mid-dig.
- **Tests:** `tests/unit/worker-sql-readonly.test.ts` (guard accepts SELECT/WITH, rejects writes/DDL/stacked/CTE-writes/auth+token tables, + the `WORKER_TOOLS`-exclusion invariant). The prompt-bloat ceiling in `tests/unit/slack-claude-worker.test.ts` was raised to 5600 for the TWO GEARS block.

---

## Portal-chat send rail (`send_portal_message`)

The Slack worker is the **only** worker with a direct (no-confirmation-code) client-facing send. Authorized by Antonio 2026-06-13: a portal chat reply is a routine, low-stakes action, and the "approval" is his explicit "send it" in the Slack thread after Claude shows the draft. Every other side-effecting capability still routes through `propose_action` → `approval_queue` → confirmation code.

- **Where it lives:** `SEND_PORTAL_MESSAGE_TOOL` + `sendPortalMessageFromWorker()` in `lib/ai-agent/worker-tools.ts`. The send mirrors the MCP `portal_chat_send` tool: insert into `portal_messages` as `sender_type='admin'` (sender_id = Antonio's auth id), resolve a contact from the account when only `account_id` is given, then fire `createPortalNotification` + `notifyClientOfAdminMessage` (in-portal alert + client email, both fire-and-forget). Plus one extra guard the MCP tool lacks: a **2-minute same-recipient+same-text dedup** so an LLM retry / cron reprocess can't double-post.
- **Gating (R108 safety):** the tool is **NOT** in the shared `WORKER_TOOLS` array — `WORKER_TOOLS` also feeds the Hermes/Telegram research worker, which must stay research-only. It is injected into the tool list **only when `CallWorkerOptions.enableSlackSend` is true**, which only `processSlackEvent` sets (alongside `enableCodeTasks`). Same pattern as `START_CODE_TASK_TOOL`. `executeWorkerTool` dispatches `send_portal_message` explicitly, before the read-only guard.
- **Why it exists:** before this, the Slack worker had no portal-send tool, so when Antonio approved a portal-chat draft and said "send it", the only reachable send was `propose_action(send_email)` — Claude proposed an **email** instead of sending the portal message. The PORTAL CHAT REPLIES prompt block now points it at `send_portal_message`.
- **Tests:** `tests/unit/slack-portal-send.test.ts` (send logic + the `WORKER_TOOLS`-exclusion invariant).

---

## Code-task rail (`start_code_task` → Mac Mini → review branch → `ship it` promote)

When the Slack worker calls `start_code_task` it inserts an `agent_messages` row with `recipient='code_runner'`, carrying `context_json.{source,title,slack_channel_id,slack_thread_ts}` so the result can be posted back to the originating thread.

`scripts/mac-mini/code-task-runner.mjs` is a launchd daemon on the Mac Mini that polls every 15 s for the oldest `recipient='code_runner'` + `status='pending'` row, atomically claims it (`status pending → processing`), and runs a headless `claude --print` session with full access.

**Per-task ISOLATION (added 2026-06-13):** the runner no longer runs the session on the shared `main` checkout. For each task it creates its own git worktree on its own branch cut from the current `origin/main` — `prepareWorktree()` → `git fetch origin main` + `git worktree add .claude/worktrees/code-task-<short8> -b code-task/<short8>-<slug> origin/main`, with `node_modules` symlinked from the main checkout so the pre-push hooks have their deps. The session runs with `cwd` = the worktree. So a task only ever sees and commits its OWN changes and can never mix with, or clobber, another session's in-flight work (no shared `main`, no `reset --hard`, no stash collisions, concurrent tasks safe). `cleanupWorktree()` tears the worktree down after; `sweepOrphanWorktrees()` at startup clears any orphaned by a crashed run. Helpers (branch name / worktree path / repo+compare URL / promote names) are pure in `scripts/mac-mini/deploy-utils.mjs`, unit-tested in `tests/unit/code-task-deploy-utils.test.ts`.

**Review branch, NOT auto-deploy (changed 2026-06-13, R104):** after a *successful* session that left commits, the runner pushes the task's BRANCH (`git push -u origin code-task/...` from the worktree — never `main`), records `context_json.code_branch` on the row, and posts the branch + a compare/PR link with "Reply 'ship it' to promote to production." Because the branch was cut from `origin/main`, it holds ONLY this task's commits — surgical. The pre-push hooks (build/tests/lint/R107 doc gate/remote-sync) run on the branch push, so a broken change never reaches a reviewable branch. **The rail no longer auto-ships to production.**

**`ship it` promotion:** when Antonio says "ship it" in the thread, the Slack worker calls the `promote_code_branch` tool → it finds that thread's last completed task's `code_branch` and queues a promote task (`context_json.promote_branch`). The runner's `promoteBranchToMain()` merges that one branch into the CURRENT `origin/main` in an isolated worktree and runs `ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin HEAD:main` — the ONLY place the rail deploys to production, gated on the explicit human "ship it". If `main` has advanced and the branch conflicts, the merge is aborted and NOTHING is pushed (reported as needs-rebase) — never a force-merge.

**Progress updates (added 2026-06-12):** the runner now posts live status to the originating thread so the user isn't left in silence between "I've queued the task" and the final result. Right after the atomic claim it posts "🔧 *<title>* — Mac Mini picked it up, working on it…"; it then arms two one-shot heartbeat timers (`HEARTBEATS`: 5 min "⏳ Still running", 10 min "⚠️ Taking longer than expected") around `runClaude`, cleared the moment the session settles — so a sub-5-min task posts none. The terminal ✅ done / ⚠️ failed post is unchanged.

**Fine-grained milestones (added 2026-06-12, stream-json):** the runner invokes the session with `--output-format stream-json --verbose` and parses the NDJSON event stream in real time via the pure helpers in `code-task-progress.mjs`. Each assistant `tool_use` maps to a coarse milestone posted to the thread — "🔍 Reading the code…" (Read/Grep/Glob/LS), "✏️ Editing code…" (Edit/Write), "🔨 Building…" / "🧪 Running tests…" / "💾 Committing…" (Bash, sub-classified by command), "🤖 Running a sub-agent…" (Task) — **deduped against the previous milestone** so a burst of reads/edits collapses to one line, but a phase that recurs after another (edit → test → edit) is re-posted to show the retry loop. The session's own `git push` tool_use is intentionally suppressed (returns null) because the runner narrates the push phase itself ("📦 Pushing to branch `code-task/…` for review…"). The heartbeats remain as the long-silence fallback. **Final-answer source changed:** with stream-json, stdout is the event stream, not the reply — `runClaude` now reads the final text + `is_error` from the terminal `result` event and falls back to stderr/raw-stdout only if the session crashed before emitting one. A `result` with `is_error:true` is a failure even on exit 0 (an auth 401 / max-turns case). **Why the runner and not the Slack worker:** the Slack worker that queues the task runs in a 300 s-capped serverless function (`slack-claude-worker/route.ts`, `maxDuration=300`) and is frozen the instant it returns — a `setInterval`/polling tracker there cannot fire. This launchd daemon is the only component alive long enough; its `setTimeout`s genuinely run during the `await runClaude`. There is no `claimed` status for code-runner rows (lifecycle is `pending → processing → done/failed`), so "picked it up" is posted on the single `pending → processing` claim transition. Note: `scripts/mac-mini/code-task-runner.mjs` runs *on the Mac Mini* — a change to it only takes effect after the Mac Mini pulls main and the launchd daemon restarts.

### ask-antonio interactive loop (added 2026-06-12)

A running code-task session can pause and ask Antonio a question in the originating Slack thread, then **block until he replies** before continuing — for the rare decision it genuinely can't make alone (a naming choice, production vs sandbox, an ambiguous requirement).

- **Exposure = a Bash CLI, not an MCP server.** The runner injects a one-line `[ASK ANTONIO]` preamble into the prompt telling the session it may run `node scripts/mac-mini/ask-antonio.mjs "question"`, and spawns the session with per-task env (`CODE_TASK_ID`, `CODE_TASK_QUESTION_CHANNEL`, `CODE_TASK_QUESTION_THREAD_TS`) that the session's Bash-tool children inherit. This avoids a stdio MCP server + `--mcp-config`/launchd wiring entirely; the blocking poll lives in the CLI process the session spawns.
- **The CLI** (`ask-antonio.mjs`) inserts a `pending` `code_task_questions` row, posts the question to the thread ("❓ *Claude needs your input:*"), then polls every 10 s (`ASK_POLL_MS`) until the row leaves `pending`. On `answered` it posts "✅ Got it — continuing." and prints the answer to stdout (the session reads it as the tool result). It self-caps at 30 min (`ASK_MAX_WAIT_MS`, override `ASK_ANTONIO_MAX_WAIT_MS`) — then marks the row `expired` and lets the session proceed without the answer.
- **The webhook answers it.** `app/api/webhooks/slack-claude/route.ts` intercepts (early, before normal mention processing) a thread reply where the sender is Antonio (`U0BAALR4Y4Q`) AND a `pending` row exists for that thread: it UPDATEs the row to `answered` (guarded `.eq('status','pending')`) and returns without running the normal bot pipeline, so Claude doesn't also respond. **Fully defensive** — any error (including the table not existing in an env yet) falls through to normal processing, so it can never break the webhook or swallow a message unless a genuine pending question is present.
- **Timeout pause.** The runner's per-task 30-min SIGKILL would otherwise kill in-progress work if Antonio is slow. While a question is pending, a watcher (`questionWatcher`, polls `code_task_questions` by `task_id` every 8 s) flips `questionPending`, and `runClaude`'s deadline watchdog pushes the kill-deadline forward each tick — so the wait is bounded by the CLI's own 30-min cap, not the task timeout. On settle the runner expires any still-pending question for the task (guarded `.eq('status','pending')`) so a late reply can't be swallowed by a finished task.
- **Concurrency is 1** (the runner processes one code task at a time), so at most one question is pending per thread.
- **Env dependency:** `code_task_questions` must exist in whatever DB the runner + webhook share (production). The webhook's defensive fall-through means deploying the code before the table exists is safe (answer routing is simply a no-op until the table is created).

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

## Stop button ("⏹ Stop")

Lets Antonio cancel a message after the "On it 👍" ack but before the worker posts its answer.

- **Ack carries the button.** The webhook posts "On it 👍" with Block Kit (`buildThinkingBlocks`): a section + a danger button (`action_id = stop_thinking`). Plain `text` stays as the notification fallback.
- **Click → `/api/webhooks/slack-interactions`.** Slack sends an `application/x-www-form-urlencoded` body with a single `payload` JSON field. The route verifies the HMAC signature (`SLACK_SIGNING_SECRET_CLAUDE`, same scheme as the events webhook — shared `verifySlackSignature`), parses it (`parseSlackInteraction`), and for `stop_thinking` runs a **conditional** UPDATE: `status='cancelled' WHERE slack_ack_ts = <clicked message ts> AND slack_channel_id = <channel> AND status IN ('pending','processing')`.
- **Correlation key = `slack_ack_ts`.** The clicked message's ts equals the ack ts already stored on the row — no row id needs to ride in the button.
- **Worker honors the stop before posting.** `processSlackEvent` re-reads the live status immediately after `callWorker` returns; if `cancelled`, it skips posting and skips the done-flip. The done-update is also guarded `.eq('status','processing')` (TOCTOU). `claimPending` only claims `status='pending'`, so a Stop that beats the claim prevents the run entirely.
- **What it can't do.** `callWorker` is a single non-interruptible API call — Stop only prevents the answer from being POSTED (or stops a not-yet-claimed run). Claude may keep thinking server-side; the result is just discarded.
- **No-op after the answer lands.** A Stop clicked once `status='done'` matches zero rows → the route leaves the Slack message (the delivered answer) untouched.
- **On stop, the ack morphs** to "⏹ Stopped — go ahead with your update" (`chat.update`, `blocks: []` to drop the button). On normal completion the worker collapses the ack to "✅" (`chat.update`, `blocks: []`) after posting the answer as a separate message.

**Setup (one-time, admin):** Slack app `A0B9LUJRLMB` → **Interactivity & Shortcuts** → enable → Request URL `https://td-operations.vercel.app/api/webhooks/slack-interactions`. Production-only (`SANDBOX_MODE=1` blocks `/api/webhooks/*`).

---

## Animated "thinking" indicator

While the worker runs `callWorker` (one non-interruptible API call, ~8–15 s), the "On it 👍" ack visibly animates so Antonio sees Claude is actively working.

- **Where:** `processSlackEvent` in `slack-claude.ts` starts a `setInterval` (`THINKING_TICK_MS = 3000`) right before the `callWorker` try-block and clears it in a `finally`, so the timer stops on success, image-retry, or rethrow alike. Node's event loop runs the timer during the `await` (Vercel Fluid Compute is plain Node).
- **What it shows:** `thinkingIndicatorText(tick)` (pure, unit-tested) cycles ascending-dot frames "🔍 Looking into it." → ".." → "..." and wraps. Each tick `chat.update`s the **same ack message** (`slack_ack_ts`) with `buildThinkingBlocks(frame)` so the "⏹ Stop" button is re-attached and stays clickable.
- **Only when there's an ack:** skipped entirely if `slack_ack_ts` is null (the ack post failed).
- **Stop-safe:** each tick re-reads the live row status and **stops the moment status ≠ `processing`** (Stop click → `cancelled`). This prevents a stray tick from clobbering the interactions webhook's "⏹ Stopped — go ahead with your update" notice or re-adding the Stop button. An in-flight flag also skips a tick while the previous `chat.update` is still pending.
- **Residual race (cosmetic only):** a sub-millisecond TOCTOU window exists — a tick can read `processing`, the Stop webhook then cancels + morphs, and the tick's already-issued `chat.update` lands after. Outcome: the ack briefly shows a "Looking into it" frame instead of "Stopped"; the worker still skips posting the answer (the post-`callWorker` cancellation re-read at `processEvent` returns early). Not worth a lock given best-effort cleanup.
- **Rate limit:** 1 `chat.update` / 3 s = 20/min, well under Slack's Tier 3 (~50/min).

## Related subsystems

- [`agent-bridge.md`](agent-bridge.md) — Hermes ↔ Claude bridge (same `agent_messages` table, same `callWorker` pattern)
- [`hooks-guardrails.md`](hooks-guardrails.md) — Sandbox enforcement (SANDBOX_MODE blocks `/api/webhooks/*`)
