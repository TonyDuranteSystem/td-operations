# Slack Claude Worker

**Subsystem:** `slack-claude-worker`
**Last verified against code:** 2026-06-10
**Owned by:** Antonio Durante LLC — dev

---

## What it does

Always-on Claude presence in Slack. When Antonio writes `@Claude` in any Slack channel or thread, Claude responds conversationally — discuss, investigate, propose — without requiring an open Claude Code session.

**Key behaviors:**
- Immediate "On it 👍" ACK within 1–2 s (Slack's 3-second requirement met every time)
- AI reply 8–15 s later via the worker cron
- Conversational tone (2–5 lines), discuss-before-act, never unilaterally mutates
- Conversation continuity: same channel/thread within 30 min → same `thread_id`
- Phase 1: `app_mention` events only

---

## Architecture

```
Slack                          Production server              Supabase
──────          ──────────────────────────────────           ────────
@Claude    →    /api/webhooks/slack-claude             →     INSERT agent_messages
                │  1. verify HMAC-SHA256 signature               (status=pending,
                │  2. URL challenge (one-time setup)              sender='slack',
                │  3. skip bots (loop protection)                 recipient='claude',
                │  4. dup-event guard (event_id)                  context_json={…})
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
| `lib/ai-agent/slack-claude.ts` | Core module: `SLACK_WORKER_SYSTEM_PROMPT`, `slackScopeKey`, `postSlackMessage`, `findOrCreateConversationThread`, `processSlackEvent` |
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
  "slack_user_id": "U0ANTONIO"
}
```

---

## Env vars required

| Var | Where | What |
|-----|-------|------|
| `SLACK_BOT_TOKEN_CLAUDE` | Vercel (both envs) | Bot OAuth token for the Claude Slack app (`A0B9LUJRLMB`), starts with `xoxb-` |
| `SLACK_SIGNING_SECRET_CLAUDE` | Vercel (both envs) | Signing secret from Slack app Basic Information page — used for HMAC request verification |
| `CRON_SECRET` | Vercel (both envs) | Shared secret for webhook → cron direct-trigger auth (same as hermes-bridge) |

**Never commit these to git.**

---

## Loop protection

The webhook handler skips incoming events when:
- `event.bot_id` is set (any bot)
- `event.user === "U0B9S675WTT"` (Claude's own user ID)
- `event.subtype === "bot_message"`

---

## Conversation scope logic

`slackScopeKey(channelId, threadTs)`:
- Top-level message → key = `channelId`
- Threaded reply → key = `channelId:threadTs`

`findOrCreateConversationThread(channelId, threadTs)`:
1. Query `agent_messages` where `created_at > now - 30 min` AND `thread_id IS NOT NULL`
2. Loop to find a row with matching `context_json.slack_scope_key`
3. If found → reuse that `thread_id` (conversation continuity)
4. If not → generate new UUID, call `createThreadSummary`, return it

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
4. Subscribe to bot event: `app_mention`
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
