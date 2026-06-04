# Hermes ↔ Claude Agent Bridge
_Last verified against code: 2026-06-04 — Claude (Phase 2 Slice 1 — approval_queue + propose_action + approval_list; nothing executes)_

## What it is
A research/discussion channel that lets the **Hermes** Telegram bot (running on the Mac Mini, talking to Antonio on mobile) ask **Claude** (a server-side worker using `claude-sonnet-4-6`) questions and get answers back, without Antonio having to be the human relay between the two tools. Eliminates the "copy from Telegram into Claude Code, copy findings back to Telegram" workflow.

This is **Phase 1 — research/discussion only.** Action authorization (Antonio approving on a portal card before Claude does anything that mutates state) is **Phase 2** (`approval_queue` + `/portal/team/approvals` + Telegram push), being built in slices — **Slice 1 (QUEUE + READ only) has shipped** (see the Phase 2 section below); nothing executes yet. Re-tiering existing write tools (`gmail_send`, CRM mutations) onto that approval rail is **Phase 3**.

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
  - `agent_msg_send` — Hermes-allowlisted write tool. INSERT, then an **awaited** POST to the worker route, bounded by a 3s `AbortController` timeout (so the trigger reliably leaves the function but the tool still returns promptly). Idempotency: if `idempotency_key` matches an existing row, return that row WITHOUT firing the worker again.
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
3. MCP tool INSERTs the row, then `await fireDirectTrigger(id)` issues `POST /api/cron/hermes-bridge?message_id=<id>` with `Authorization: Bearer ${CRON_SECRET}`, bounded by a 3s timeout. The await guarantees the request leaves the function; the timeout caps how long the tool blocks.
4. Worker route (direct mode) atomically claims, then runs `callWorker(body)` to completion server-side and writes `reply` + `status='done'`. For simple queries this is ~5-10s end to end; the route function keeps running even after the trigger's 3s client timeout.
5. (Parallel safety net) every 5 min the cron tick runs the route in scan mode. Stale `processing` rows older than 10 min get recovered. Up to 5 pending rows get processed.
6. Hermes, on Antonio's next Telegram turn, calls `agent_inbox_list({ as_party: 'hermes', filter: 'my_replies' })` — gets the row(s) with replies, summarizes to Antonio in plain English.

## Gotchas, invariants & past bugs
- **The Phase 1 worker has NO write tools.** Any action implied by the request is described in the reply text, never executed. Adding a write tool to `WORKER_READ_ONLY_TOOL_NAMES` is a deliberate security decision — the unit test asserts the set contains no write-shaped names (`send_/create_/update_/advance_/save_/delete_/insert_/mark_`).
- **`run_sql_query` is INTENTIONALLY excluded** even though it's read-only in `lib/ai-agent/tools.ts`. Raw SQL bypasses the schema-level validation in `search_*` tools and adds risk for no upside. Don't re-add.
- **Direct trigger is awaited but timeout-bounded (3s).** The original fire-and-forget fetch was getting killed when the MCP serverless function froze right after returning, so rows only got processed by the 5-min cron (~1-5 min latency — observed live 2026-06-03). Fix: `agent_msg_send` now `await`s the trigger so it reliably leaves the function, but with a 3s `AbortController` timeout so the tool doesn't block on the full sonnet loop — the worker route runs to completion **server-side** regardless of the client timeout. Never throws (the AbortError is expected; cron is still the net). **Tried and rejected:** `@vercel/functions` `waitUntil` to background the worker — importing it broke the route on Next 14.2 ("No response is returned from route handler", both modes). Do not reintroduce it without verifying on a sandbox deploy first.
- **Atomic claim is the only race protection.** Both the direct trigger and the cron can fire on the same row near-simultaneously. The `UPDATE … WHERE status='pending' RETURNING *` pattern makes exactly one win. Don't replace with a non-atomic check-then-update.
- **Stale-claim recovery has a 10-min cutoff.** A row stuck in `processing` because the worker function crashed mid-job (after claim, before reply write) is reclaimed by the next scan-mode tick. 10 min is long enough to comfortably exceed the longest sonnet loop (~2 min) but short enough to keep latency bounded.
- **Idempotency_key check happens BEFORE INSERT.** A duplicate `idempotency_key` returns the existing row and does NOT fire the worker again. Without this guard, a Telegram retry would re-trigger sonnet for free.
- **The MCP tool description itself contains the approval rule.** Defense-in-depth: not just `USER.md` / `CLAUDE.md` text, but the tool's MCP description string tells the calling agent the rule. Don't strip those instruction lines.
- **Phase 1 is research only.** If you add an MCP tool that proposes a mutation on behalf of a Hermes message, you've broken the Phase 1 contract. Mutations belong on the Phase 2 approval rail (not yet built).

## Phase 2 — action-authorization rail (Slice 1: QUEUE + READ only)
_Shipped 2026-06-04. **Nothing executes in Slice 1.** It builds the queue + read side; approve/reject transitions, the execute worker, and the portal page are later slices._

- **Why:** Phase 1's worker can only describe an implied action. Phase 2 gives those actions a durable home so Antonio can approve them. Slice 1 deliberately stops at "queued" — the risky half (running the action) is isolated to a separate, reviewable slice.
- **Table:** `approval_queue` — `id`, `batch_id` (nullable), `source_message_id` (nullable FK → `agent_messages(id)` ON DELETE SET NULL), `requested_by` (`agent_message_party`, default `worker`), `tool_name`, `params` (jsonb), `params_hash` (SHA-256 of `JSON.stringify(params)`), `rationale`, `status` (`approval_status`), `decided_by`/`decided_at`, `claimed_at`/`claimed_by`/`executed_at`/`result`/`error_text`, `idempotency_key` (partial UNIQUE), `expires_at` (default now()+24h), `created_at`, `updated_at`.
  - Enum `approval_status`: `pending`, `approved`, `rejected`, `executing`, `executed`, `failed`, `expired`. **Slice 1 only ever writes `pending`.**
  - RLS enabled, no policies → service-role-only (`supabaseAdmin`). Same posture as `agent_messages`.
  - Migration: `scripts/migrations/20260604-1100-approval-queue.sql`. Reuses the existing `agent_message_party` enum.
- **Approvable allow-list (pure, DB-free):** `lib/ai-agent/approvable-tools.ts`
  - `APPROVABLE_TOOL_NAMES` — closed set of **12** action tools that may be proposed: `create_task`, `update_task`, `update_account_notes`, `update_contact`, `update_service`, `advance_service_stage`, `send_email`, `drive_move`, `drive_upload_file`, `gmail_get_attachments`, `log_conversation`, `save_memory`. Every name maps to a real `AGENT_TOOLS` entry (unit test asserts this).
  - `isApprovableTool(name)`, `computeParamsHash(params)` (sha256 of `JSON.stringify`), `validateToolParams(name, params)` (minimal JSON-Schema check against `AGENT_TOOLS` — required keys, types, enums; lenient on unknown extra keys).
  - `APPROVABLE_TOOL_CONSTRAINTS` — per-tool metadata for the future approval card: `label`, `surface` (param keys the approver must see), and risk flags `external` (send_email — leaves TD), `cascades` (advance_service_stage — auto-tasks), `irreversible`.
- **Worker tool:** `propose_action` in `lib/ai-agent/worker-tools.ts`
  - Added to `WORKER_TOOLS` (the read-only research subset **plus** `propose_action`). It is **NOT** in `WORKER_READ_ONLY_TOOL_NAMES` — it's wired separately, so the write-prefix safety scan still governs that set.
  - `executeWorkerTool` routes `propose_action` → `proposeAction()`; the read subset → `executeTool`; everything else is rejected.
  - `proposeAction()` validates tool_name against the allow-list + params against the tool schema, computes `params_hash`, then INSERTs a `pending` row. Idempotency: a matching `idempotency_key` whose row is `pending`/`approved` returns that row, no duplicate. **It never calls `executeTool` — it only queues.**
  - Worker system prompt updated: "when an action is implied, call `propose_action` (do NOT describe-only); it will NOT execute until Antonio approves."
- **MCP read tool:** `approval_list` in `lib/mcp/tools/agent-approvals.ts` — `approval_list(status='pending', limit=20)`, newest-first, READ-ONLY. Registered in `app/api/[transport]/route.ts` via `registerAgentApprovalTools(server)`; described in `lib/mcp/instructions.ts`.
- **Slice 1 invariants:**
  - No execute path exists. `proposeAction` and `approval_list` are the only code touching `approval_queue`, and neither runs an action.
  - The 12 action tools remain unreachable directly by the worker — `executeWorkerTool('send_email', …)` is still rejected (regression test pins this).
  - Tests: `tests/unit/approval-rail.test.ts` (allow-list, hash, validation, propose/reject/idempotency, list) + the updated `tests/unit/agent-bridge-worker-tools.test.ts` (`WORKER_TOOLS` = read subset + `propose_action`).

## How to verify current state
- Read `lib/mcp/tools/agent-messages.ts` (the 3 MCP tools + `fireDirectTrigger`), `lib/ai-agent/worker-tools.ts` (the allow-list + `callWorker`), `app/api/cron/hermes-bridge/route.ts` (the cron worker).
- Confirm the cron is registered: `grep -A 2 hermes-bridge vercel.json`.
- Sanity-check the table exists in sandbox: `SELECT count(*), status FROM agent_messages GROUP BY status` (via sandbox MCP `execute_sql` or `psql`).
- Confirm the worker allow-list contains no write-shaped names: `npm run test:unit -- agent-bridge-worker-tools` should pass.
- Hermes-side config: `~/.hermes/config.yaml` must list `agent_msg_send` (and `agent_inbox_list`) under `mcp_servers.td_sandbox_readonly.tools.include`. The `~/.hermes/memories/USER.md` must contain the "Email/agent send discipline" rule.
- Production sanity: `vercel cron list` in the production project should show `/api/cron/hermes-bridge` at `*/5 * * * *`.
- Sandbox QA scenarios are listed in dev_task `1a0d1354`'s description (idempotency, race, stale recovery, failure path).
