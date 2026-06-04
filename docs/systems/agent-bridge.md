# Hermes ↔ Claude Agent Bridge
_Last verified against code: 2026-06-04 — Claude (Phase 2 Slice 4: proposal formatter + Hermes-side approval rail wiring — Hermes can now present pending proposals and call approval_decide)_

## What it is
A research/discussion channel that lets the **Hermes** Telegram bot (running on the Mac Mini, talking to Antonio on mobile) ask **Claude** (a server-side worker using `claude-sonnet-4-6`) questions and get answers back, without Antonio having to be the human relay between the two tools. Eliminates the "copy from Telegram into Claude Code, copy findings back to Telegram" workflow.

This is **Phase 1 — research/discussion only.** Action authorization (Antonio approving before Claude does anything that mutates state) is **Phase 2** (`approval_queue` + `approval_decide` + the `approval-executor` worker; `/portal/team/approvals` + Telegram push are later slices), being built in slices — **Slices 1–4 have shipped** (1: QUEUE + READ; 2: DECISION + EXECUTION, kill-switch-gated; 3: enum normalization + full-rail E2E; 4: proposal formatter + Hermes-side approval wiring — see the Phase 2 sections below). Re-tiering existing write tools (`gmail_send`, CRM mutations) onto that approval rail is **Phase 3**.

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
- **Table:** `approval_queue` — `id`, `batch_id` (nullable), `source_message_id` (nullable FK → `agent_messages(id)` ON DELETE SET NULL), `requested_by` (`agent_message_party`, default `worker`), `tool_name`, `params` (jsonb), `params_hash` (SHA-256 of the canonical key-sorted JSON of `params` — see JSONB gotcha), `rationale`, `status` (`approval_status`), `decided_by`/`decided_at`, `claimed_at`/`claimed_by`/`executed_at`/`result`/`error_text`, `idempotency_key` (partial UNIQUE), `expires_at` (default now()+24h), `created_at`, `updated_at`.
  - Enum `approval_status`: `pending`, `approved`, `rejected`, `executing`, `executed`, `failed`, `expired`. **Slice 1 only ever writes `pending`.**
  - RLS enabled, no policies → service-role-only (`supabaseAdmin`). Same posture as `agent_messages`.
  - Migration: `scripts/migrations/20260604-1100-approval-queue.sql`. Reuses the existing `agent_message_party` enum.
- **Approvable allow-list (pure, DB-free):** `lib/ai-agent/approvable-tools.ts`
  - `APPROVABLE_TOOL_NAMES` — closed set of **12** action tools that may be proposed: `create_task`, `update_task`, `update_account_notes`, `update_contact`, `update_service`, `advance_service_stage`, `send_email`, `drive_move`, `drive_upload_file`, `gmail_get_attachments`, `log_conversation`, `save_memory`. Every name maps to a real `AGENT_TOOLS` entry (unit test asserts this).
  - `isApprovableTool(name)`, `computeParamsHash(params)` (sha256 of the **key-order-canonical** JSON — keys recursively sorted; see the JSONB gotcha below), `validateToolParams(name, params)` (minimal JSON-Schema check against `AGENT_TOOLS` — required keys, types, enums; lenient on unknown extra keys).
  - `APPROVABLE_TOOL_CONSTRAINTS` — per-tool metadata for the future approval card: `label`, `surface` (param keys the approver must see), and risk flags `external` (send_email — leaves TD), `cascades` (advance_service_stage — auto-tasks), `irreversible`.
- **Worker tool:** `propose_action` in `lib/ai-agent/worker-tools.ts`
  - Added to `WORKER_TOOLS` (the read-only research subset **plus** `propose_action`). It is **NOT** in `WORKER_READ_ONLY_TOOL_NAMES` — it's wired separately, so the write-prefix safety scan still governs that set.
  - `executeWorkerTool` routes `propose_action` → `proposeAction()`; the read subset → `executeTool`; everything else is rejected.
  - `proposeAction()` first **normalizes enum-backed params** via `lib/ai-agent/enum-normalization.ts::normalizeToolParams` (so a proposal with `priority:'medium'` / `status:'todo'` is accepted → `'Normal'` / `'To Do'`), then validates tool_name against the allow-list + params against the tool schema, computes `params_hash`, then INSERTs a `pending` row. Normalizing **before** hashing means the stored params (and `params_hash`) reflect exactly what will execute. Idempotency: a matching `idempotency_key` whose row is `pending`/`approved` returns that row, no duplicate. **It never calls `executeTool` — it only queues.**
  - Worker system prompt updated: "when an action is implied, call `propose_action` (do NOT describe-only); it will NOT execute until Antonio approves."
- **MCP read tool:** `approval_list` in `lib/mcp/tools/agent-approvals.ts` — `approval_list(status='pending', limit=20)`, newest-first, READ-ONLY. Registered in `app/api/[transport]/route.ts` via `registerAgentApprovalTools(server)`; described in `lib/mcp/instructions.ts`.
- **Slice 1 invariants:**
  - No execute path exists. `proposeAction` and `approval_list` are the only code touching `approval_queue`, and neither runs an action.
  - The 12 action tools remain unreachable directly by the worker — `executeWorkerTool('send_email', …)` is still rejected (regression test pins this).
  - Tests: `tests/unit/approval-rail.test.ts` (allow-list, hash, validation, propose/reject/idempotency, list) + the updated `tests/unit/agent-bridge-worker-tools.test.ts` (`WORKER_TOOLS` = read subset + `propose_action`).

## Phase 2 — Slice 2: decision + execution rail
_Shipped 2026-06-04 (sandbox). **Approved actions now run for real**, gated by a kill switch. No new migration — `approval_queue` already had every column Slice 2 writes (verified against the sandbox schema)._

- **Why:** Slice 1 queued proposals but executed nothing. Slice 2 closes the loop: a human approves a pending proposal and an isolated executor runs the real action, then reports the outcome back to Hermes. The risky half (running actions) is deliberately one reviewable slice.
- **Decision tool:** `approval_decide` in `lib/mcp/tools/agent-approvals.ts`
  - `approval_decide(id, decision: 'approve'|'reject', note?)`.
  - **approve:** atomic `UPDATE … SET status='approved', decided_by='antonio', decided_at WHERE id=X AND status='pending'` (no-op if not pending). Then `fireExecutorTrigger(id)` — an **awaited, 3s-`AbortController`-bounded** `POST /api/cron/approval-executor?id=<uuid>` (`Authorization: Bearer ${CRON_SECRET}`). Mirrors `fireDirectTrigger` exactly (reuses the exported `getInternalBaseUrl`). **No `waitUntil`.**
  - **reject:** atomic `UPDATE … SET status='rejected', decided_by, decided_at WHERE id=X AND status='pending'`, then `writeOutcomeCallback(id, tool, 'Proposal <tool> rejected: <note>', 'rejected')`.
  - **MANDATORY discipline** carried in the tool description: Hermes/Claude must show Antonio the exact tool_name + params + recipient/cascade/external flags and wait for explicit OK before `approve` — same rule as `gmail_send` / `agent_msg_send`. Never auto-approve.
  - Registered via the same `registerAgentApprovalTools(server)`; described in `lib/mcp/instructions.ts`.
- **Executor route:** `app/api/cron/approval-executor/route.ts` — thin auth wrapper (`CRON_SECRET` Bearer, `maxDuration=300`); all logic in `lib/ai-agent/approval-executor.ts`.
  - **Kill switch:** `APPROVAL_RAIL_ENABLED` must `=== 'true'`, else the route returns `{ok:true, disabled:true}` and runs nothing. `propose_action` keeps queuing regardless — the switch only stops execution.
  - **Direct mode** (`?id=<uuid>`): claim + execute exactly that row.
  - **Scan mode** (no `?id`, cron `*/5 * * * *`): (1) recover rows stuck in `executing` > 10 min back to `approved`; (2) execute up to 10 `approved` rows a direct trigger missed; (3) expire `pending` rows past `expires_at` (+callback each).
- **Per-row execution** (`lib/ai-agent/approval-executor.ts`):
  1. **Atomic claim:** `UPDATE … SET status='executing', claimed_at, claimed_by='approval-executor' WHERE id=X AND status='approved' RETURNING …`. 0 rows → return early (already claimed/decided). **This is the only double-execution guard.**
  2. **params_hash re-check:** recompute `computeParamsHash(stored params)`; mismatch → `status='failed'`, `error_text='params_hash integrity mismatch'`, callback, **action never runs**.
     - **JSONB key-order gotcha (found via the Slice 2 sandbox E2E, 2026-06-04):** `params` is stored as JSONB, which does NOT preserve object key insertion order — it reorders keys internally. The hash MUST therefore be computed over a **canonical** (recursively key-sorted) JSON form on BOTH sides, or the execute-time recompute never matches the propose-time hash for any params with ≥2 keys, silently failing every real action with `integrity`. `computeParamsHash` canonicalizes; a regression test pins key-order independence (`tests/unit/approval-rail.test.ts`). Unit mocks preserved key order, so only the real-Postgres E2E exposed this — keep an E2E in the loop for any future hash change.
  3. **Execute:** `await executeTool(tool_name, params)`.
  4. **Outcome:** success → `status='executed', result=<jsonb>, executed_at`; throw OR error-shaped result → `status='failed', error_text, executed_at`. **`executeTool` catches its own errors and returns an `{error:…}` string rather than throwing — `interpretToolResult` inspects the result so a logically-failed action is marked `failed`, not `executed`.** (Deviation from the literal "on throw → failed" plan, made deliberately so a failed send is never reported as executed.)
  5. **Callback:** `writeOutcomeCallback` always fires on a terminal state.
- **Outcome callback helper:** `lib/ai-agent/approval-callback.ts::writeOutcomeCallback(approvalId, toolName, summary, status)` — INSERTs an `agent_messages` row `sender='worker', recipient='hermes', status='done', reply=<summary>, context_json={approval_id, tool_name, outcome_status}`. (`agent_messages.subject`/`body` are NOT NULL, so it supplies both; `sender<>recipient` CHECK is satisfied by worker→hermes.) Used by the executor (executed/failed), `approval_decide` (rejected), and the expiry sweep (expired). Kept dependency-light (imports only `supabaseAdmin`) so the MCP tool doesn't pull the `executeTool` graph.
- **Cron registration:** `vercel.json` + `lib/cron-coverage.ts` both carry `/api/cron/approval-executor` at `*/5 * * * *` (the completeness test pins them in sync).
- **Slice 2 invariants:**
  - Idempotent by atomic claim: a row is executed at most once even if direct trigger + cron race.
  - Nothing executes unless `APPROVAL_RAIL_ENABLED='true'` AND a human approved the row.
  - `executed` rows are never re-run (claim only matches `approved`).
  - Tests: `tests/unit/approval-executor.test.ts` (happy path, error-shaped result, throw, atomic single-winner claim, integrity mismatch, reject, approve, expiry, crash recovery, kill switch).

## Phase 2 — Slice 3: enum normalization + full-rail E2E verification
_Shipped 2026-06-04 (sandbox)._

- **Part 1 — enum normalization** (`lib/ai-agent/enum-normalization.ts`): the approvable tools write to/filter on real Postgres ENUM columns; flexible input is now mapped to the canonical DB value at execution AND in `proposeAction` (before validate/hash). See `ai-agent.md` for the full write-up.
- **Part 2 — systematic rail E2E:** all 12 approvable tools were driven through the FULL `propose → approve → execute` cycle against sandbox via `scripts/test-approval-rail-s3.ts` (a `tsx` driver: real `proposeAction` → assert `pending` + `params_hash` → `UPDATE status='approved'` → HTTP `GET /api/cron/approval-executor?id=` with `CRON_SECRET` → assert terminal status + `result` + outcome callback → tool-effect check → full cleanup). **Result: 12/12 pass**, zero sandbox residue.
  - `SANDBOX_MODE=1` mocks Gmail send (`{success:true,sandbox:true}`) and Drive writes (`moveFile→{id:fileId}`, `uploadBinaryToDrive→{id:'sandbox-mock'}`) to success, so `send_email`/`drive_move`/`drive_upload_file` resolve **executed** with NO real external effect. `gmail_get_attachments` uses `gmailGet` (NOT mocked), so a fake message_id yields a real 404 → **failed**, which the rail captures cleanly with a callback — the intended failure-path proof.
  - **Two pre-existing write-tool bugs found + fixed** (both also affected the in-dashboard agent, not just the rail): (1) `createTask`/`advanceServiceStage` auto-tasks omitted `attachments` (`tasks.attachments` is `NOT NULL`, no default) → every real insert threw `23502`; (2) `advanceServiceStage` filtered `service_deliveries.eq('service_id', …)` — a nonexistent column — so it never found a delivery; the lookup is now `.eq('id', …)` (the id the agent actually holds). See `ai-agent.md` gotchas + `tests/unit/agent-tools-insert-shape.test.ts`.
  - **Lesson:** mocked-Supabase unit tests can't catch NOT-NULL / wrong-column DB errors. The real-DB rail E2E is the only thing that surfaced both — keep `scripts/test-approval-rail-s3.ts` runnable for any future approvable-tool change.

## Phase 2 — Slice 4: proposal formatter + Hermes-side approval wiring
_Shipped 2026-06-04 (sandbox). No new migration, no new server tool — Slice 4 makes the EXISTING `approval_list`/`approval_decide` tools usable from Hermes and gives both sides one shared way to render a proposal for Antonio._

- **Why:** Slices 1–3 built the full server rail (queue → decide → execute → callback) and proved it end-to-end. But Hermes (on the Mac Mini) still had no way to (a) reach the decision tools, nor (b) present a pending proposal to Antonio in a consistent, risk-aware form. Slice 4 closes that last gap so Antonio can actually approve/reject from his phone.
- **Proposal formatter** (`lib/ai-agent/format-approval-proposal.ts`) — a **pure, DB-free** `formatApprovalProposal(row)` that renders an `approval_queue` row into a plain-text, mobile-friendly Telegram message:
  ```
  📋 Action Proposal #<short-id>

  🔧 <Tool Label>
     <key>: <value>     (one line per SURFACED param present)

  ⚠️ <External recipient / Cascades / Irreversible>   (only if the tool has flags)

  💡 <rationale>        (only if present)

  To approve: APPROVE <short-id>
  To reject: REJECT <short-id> <reason>
  ```
  - **Single source of truth for surfacing:** label, which params to show, and the risk flags all come from `APPROVABLE_TOOL_CONSTRAINTS` in `approvable-tools.ts`. Adding a tool / flag there automatically flows into the message — the formatter never hardcodes per-tool logic. The eventual `/portal/team/approvals` card should reuse the same constraint metadata so the two views can't drift.
  - **short-id = first 8 chars of the UUID** (`shortId()`), what Antonio types in `APPROVE <id>` / `REJECT <id> <reason>`.
  - **Graceful degradation:** unknown tool → label falls back to the raw `tool_name` and ALL params are surfaced (can't know which matter); absent surface params are skipped; null/empty params → `(no parameters)` placeholder; null/empty rationale → the 💡 line is omitted; values are newline-collapsed and truncated to 240 chars (so a 20k-char email body doesn't blow up the message).
  - **Formats only — never approves, never executes.** The MANDATORY discipline (show Antonio the full proposal, wait for explicit OK before `approval_decide(approve)`) lives in the MCP tool description + Hermes's `USER.md`.
  - Tests: `tests/unit/format-approval-proposal.test.ts` (21 cases — create_task all-params, send_email external/irreversible flags + newline collapse, advance_service_stage cascade flag, missing/null params, unknown-tool fallback, long-value truncation, 8-char short id).
- **Hermes-side wiring (Mac Mini, NOT in this repo — Hermes is a separate Python app at `~/.hermes/`):**
  - `~/.hermes/config.yaml` → `mcp_servers.td_sandbox_readonly.tools.include` now also lists `approval_list` and `approval_decide` (alongside `agent_msg_send`, `agent_inbox_list`, etc.). The server already exposes both (registered via `registerAgentApprovalTools` in `app/api/[transport]/route.ts`); the include list is the client-side allow filter, so this is the only change needed to let Hermes call them.
  - `~/.hermes/memories/USER.md` → new **"## Approval Rail (Phase 2)"** section: Hermes presents pending proposals using the formatted view (tool, key params, risk flags, rationale, APPROVE/REJECT), **NEVER auto-approves** (same discipline as `gmail_send`/`agent_msg_send`), maps Antonio's "approve"/"reject" to `approval_decide(id, 'approve'|'reject', note)`, surfaces expired/failed/rejected callbacks from `agent_messages`, and polls `approval_list` periodically.
- **What Hermes needs on the Mac Mini side (to be live):** the two config edits above are already applied on THIS machine's `~/.hermes/`. If Hermes runs on a different machine, the same two edits must be made there. Hermes must be restarted (or reload its MCP config) so the new `include` entries take effect. `SANDBOX_MCP_TOKEN` must already be set (it gates the existing `agent_msg_send`/`agent_inbox_list` tools, so no new secret is required). No production change — the rail stays sandbox-only and `APPROVAL_RAIL_ENABLED` still gates execution.

## How to verify current state
- Read `lib/mcp/tools/agent-messages.ts` (the 3 MCP tools + `fireDirectTrigger`), `lib/ai-agent/worker-tools.ts` (the allow-list + `callWorker`), `app/api/cron/hermes-bridge/route.ts` (the cron worker).
- **Phase 2 Slice 3:** `APPROVAL_RAIL_ENABLED=true` in `.env.local`, run `npm run dev`, then `npx tsx scripts/test-approval-rail-s3.ts` → expect a 12/12 PASS matrix (11 executed, gmail_get_attachments failed-by-design) and `🧹 cleanup done`. `npm run test:unit -- agent-tools-insert-shape enum-normalization` should pass.
- **Phase 2 Slice 4:** `npm run test:unit -- format-approval-proposal` should pass (21 cases). Confirm Hermes wiring: `grep approval_ ~/.hermes/config.yaml` shows `approval_list, approval_decide` in the `td_sandbox_readonly` include list, and `grep -A1 "Approval Rail" ~/.hermes/memories/USER.md` shows the Phase 2 section. (Hermes config is on the Mac Mini, NOT in this repo.)
- Confirm the cron is registered: `grep -A 2 hermes-bridge vercel.json`.
- Sanity-check the table exists in sandbox: `SELECT count(*), status FROM agent_messages GROUP BY status` (via sandbox MCP `execute_sql` or `psql`).
- Confirm the worker allow-list contains no write-shaped names: `npm run test:unit -- agent-bridge-worker-tools` should pass.
- Hermes-side config: `~/.hermes/config.yaml` must list `agent_msg_send` (and `agent_inbox_list`) under `mcp_servers.td_sandbox_readonly.tools.include`. The `~/.hermes/memories/USER.md` must contain the "Email/agent send discipline" rule.
- Production sanity: `vercel cron list` in the production project should show `/api/cron/hermes-bridge` at `*/5 * * * *`.
- Sandbox QA scenarios are listed in dev_task `1a0d1354`'s description (idempotency, race, stale recovery, failure path).
- **Phase 2 Slice 2:** `npm run test:unit -- approval-executor` should pass. Confirm the executor cron is registered: `grep -A2 approval-executor vercel.json`. Confirm the kill switch: the executor route returns `{disabled:true}` unless `APPROVAL_RAIL_ENABLED='true'`. `approval_queue` needs no Slice 2 migration — verify its columns (`decided_by`, `claimed_at`, `executed_at`, `result`, `error_text`) and the `approval_status` enum (`executing`/`executed`/`failed`/`expired`) exist: `psql "$SUPABASE_DB_URL" -c "\d approval_queue"` against sandbox.
