# Hermes ↔ Claude Agent Bridge
_Last verified against code: 2026-06-03 — Claude (built Phase 1 in dev_task `1a0d1354`)_

## What it is
A research/discussion channel that lets the **Hermes** Telegram bot (running on the Mac Mini, talking to Antonio on mobile) ask **Claude** (a server-side worker using `claude-sonnet-4-6`) questions and get answers back, without Antonio having to be the human relay between the two tools. Eliminates the "copy from Telegram into Claude Code, copy findings back to Telegram" workflow.

This is **Phase 1 — research/discussion only.** Action authorization (Antonio approving on a portal card before Claude does anything that mutates state) is a separate **Phase 2** (`approval_queue` + `/portal/team/approvals` + Telegram push). Re-tiering existing write tools (`gmail_send`, CRM mutations) onto that approval rail is **Phase 3**.

## Business rules
- **Hermes is restricted to research/discussion.** It can ask Claude things and read findings — it cannot ask Claude to send emails, modify records, push code, or run anything with side effects via this rail. (Phase 2 will move action requests to the approval rail.)
- **Mandatory approval rule on `agent_msg_send`** — same discipline as `gmail_send` (CLAUDE.md R092 / R108). Hermes (and Claude Code) must show the full draft (recipient, subject, body verbatim) in chat and wait for Antonio's explicit OK before calling the tool. Established after the 2026-06-03 unauthorized-send incident on `gmail_send`. Enforced in both `CLAUDE.md` and `~/.hermes/memories/USER.md`.
- **Worker is read-only.** The set of tools the worker can invoke is a curated subset of `lib/ai-agent/tools.ts` — no `send_*`, no `create_*`, no `update_*`, no `advance_*`, no `save_*`, no `run_sql_query`. Tests assert this. (See `lib/ai-agent/worker-tools.ts`.)
- **Antonio is the only Telegram user the bot answers.** Enforced at the Hermes config layer (`TELEGRAM_ALLOWED_USERS=307359927`), not by this subsystem.

## How it's built
- **Tables / columns:**
  - `agent_messages` — `id`, `sender`, `recipient`, `subject`, `body`, `status`, `reply`, `replied_at`, `claimed_at`, `claimed_by`, `context_json`, `idempotency_key (UNIQUE)`, `error_text`, `created_at`, `updated_at`.
  - Enums: `agent_message_party` (`hermes`, `claude`, `worker`), `agent_message_status` (`pending`, `processing`, `done`, `failed`, `cancelled`).
  - RLS enabled with no policies → service-role-only (`supabaseAdmin`). No anon/authenticated/portal access. Ever.
  - Migration: `scripts/migrations/20260603-1510-agent-messages-bridge.sql`.
- **MCP tools:** `lib/mcp/tools/agent-messages.ts`
  - `agent_msg_send` — Hermes-allowlisted write tool. INSERT, then fire-and-forget POST to the worker route. Idempotency: if `idempotency_key` matches an existing row, return that row WITHOUT firing the worker again.
  - `agent_inbox_list` — perspective-relative read. `filter` ∈ `inbound_pending | inbound_all | my_replies | my_sent | all`.
  - `agent_inbox_reply` — manual fallback writer; the cron worker is the primary writer.
  - Registered in `app/api/[transport]/route.ts` via `registerAgentMessageTools(server)`.
- **Worker:** `app/api/cron/hermes-bridge/route.ts`
  - Auth: `CRON_SECRET` Bearer (same key the cron scheduler uses and the MCP tool uses for the direct trigger).
  - Two modes, same handler, both `GET` and `POST` accepted:
    - **Direct mode** (`?message_id=<uuid>`): claim + process exactly that row. Called from `agent_msg_send` via fire-and-forget `fetch` for low latency.
    - **Scan mode** (no query param): cron behaviour. (1) Stale-claim recovery — any `processing` row with `claimed_at < now() - 10 min` is set back to `pending`. (2) Process up to 5 oldest pending Hermes→Claude rows from the last 24h.
  - Atomic claim: `UPDATE … SET status='processing', claimed_at, claimed_by WHERE id=$1 AND status='pending' RETURNING *`. If 0 rows, the row was already claimed (race lost) — exit quietly for that row.
  - Per-row processing: `callWorker(row.body)` → on success update `status='done', reply, replied_at`; on error update `status='failed', error_text`. Errors are NOT re-thrown — caller wants a summary, not a 500.
  - Logging: `lib/cron-log.ts::logCron` with `details: { mode, processed, results }`.
- **Worker call path:** `lib/ai-agent/worker-tools.ts`
  - `WORKER_READ_ONLY_TOOL_NAMES` — the allow-list set.
  - `WORKER_TOOLS` — `AGENT_TOOLS.filter(t => allowlist.has(t.name))`.
  - `executeWorkerTool(name, params)` — wraps `executeTool` with an allow-list check (defense-in-depth).
  - `WORKER_SYSTEM_PROMPT` — research-only framing, plain-English output discipline.
  - `callWorker(userBody)` — mirrors `callClaude` in `lib/ai-agent/providers.ts` but uses the worker subset + worker system prompt. Direct Anthropic API (`claude-sonnet-4-6`), max 8 tool loops, 55s per-call timeout.
- **Cron schedule:** `vercel.json` `{ path: "/api/cron/hermes-bridge", schedule: "*/5 * * * *" }` — runs every 5 min as the safety net.
- **Direct-trigger URL resolution:** `lib/mcp/tools/agent-messages.ts::getInternalBaseUrl()` — `APP_BASE_URL` → `https://${VERCEL_URL}` → `http://localhost:3000`.

## Data flow / triggers
1. Antonio + Hermes discuss on Telegram. Antonio approves the draft.
2. Hermes calls `agent_msg_send({ recipient: 'claude', subject, body })`.
3. MCP tool INSERTs the row, then `fireDirectTrigger(id)` issues `POST /api/cron/hermes-bridge?message_id=<id>` with `Authorization: Bearer ${CRON_SECRET}`. Tool returns row id immediately (no await).
4. Worker route (direct mode) atomically claims, calls `callWorker(body)`, writes `reply` + `status='done'`. ~30-90s typical.
5. (Parallel safety net) every 5 min the cron tick runs the route in scan mode. Stale `processing` rows older than 10 min get recovered. Up to 5 pending rows get processed.
6. Hermes, on Antonio's next Telegram turn, calls `agent_inbox_list({ as_party: 'hermes', filter: 'my_replies' })` — gets the row(s) with replies, summarizes to Antonio in plain English.

## Gotchas, invariants & past bugs
- **The Phase 1 worker has NO write tools.** Any action implied by the request is described in the reply text, never executed. Adding a write tool to `WORKER_READ_ONLY_TOOL_NAMES` is a deliberate security decision — the unit test asserts the set contains no write-shaped names (`send_/create_/update_/advance_/save_/delete_/insert_/mark_`).
- **`run_sql_query` is INTENTIONALLY excluded** even though it's read-only in `lib/ai-agent/tools.ts`. Raw SQL bypasses the schema-level validation in `search_*` tools and adds risk for no upside. Don't re-add.
- **Direct trigger is fire-and-forget.** The MCP tool does NOT await the fetch. If the fetch fails (network blip, Vercel kills the calling function before the request lands), the 5-min cron picks it up. There's no try-await-block to add here — that would defeat the latency benefit.
- **Atomic claim is the only race protection.** Both the direct trigger and the cron can fire on the same row near-simultaneously. The `UPDATE … WHERE status='pending' RETURNING *` pattern makes exactly one win. Don't replace with a non-atomic check-then-update.
- **Stale-claim recovery has a 10-min cutoff.** A row stuck in `processing` because the worker function crashed mid-job (after claim, before reply write) is reclaimed by the next scan-mode tick. 10 min is long enough to comfortably exceed the longest sonnet loop (~2 min) but short enough to keep latency bounded.
- **Idempotency_key check happens BEFORE INSERT.** A duplicate `idempotency_key` returns the existing row and does NOT fire the worker again. Without this guard, a Telegram retry would re-trigger sonnet for free.
- **The MCP tool description itself contains the approval rule.** Defense-in-depth: not just `USER.md` / `CLAUDE.md` text, but the tool's MCP description string tells the calling agent the rule. Don't strip those instruction lines.
- **Phase 1 is research only.** If you add an MCP tool that proposes a mutation on behalf of a Hermes message, you've broken the Phase 1 contract. Mutations belong on the Phase 2 approval rail (not yet built).

## How to verify current state
- Read `lib/mcp/tools/agent-messages.ts` (the 3 MCP tools + `fireDirectTrigger`), `lib/ai-agent/worker-tools.ts` (the allow-list + `callWorker`), `app/api/cron/hermes-bridge/route.ts` (the cron worker).
- Confirm the cron is registered: `grep -A 2 hermes-bridge vercel.json`.
- Sanity-check the table exists in sandbox: `SELECT count(*), status FROM agent_messages GROUP BY status` (via sandbox MCP `execute_sql` or `psql`).
- Confirm the worker allow-list contains no write-shaped names: `npm run test:unit -- agent-bridge-worker-tools` should pass.
- Hermes-side config: `~/.hermes/config.yaml` must list `agent_msg_send` (and `agent_inbox_list`) under `mcp_servers.td_sandbox_readonly.tools.include`. The `~/.hermes/memories/USER.md` must contain the "Email/agent send discipline" rule.
- Production sanity: `vercel cron list` in the production project should show `/api/cron/hermes-bridge` at `*/5 * * * *`.
- Sandbox QA scenarios are listed in dev_task `1a0d1354`'s description (idempotency, race, stale recovery, failure path).
