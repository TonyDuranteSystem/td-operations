# Hermes Operating Agent — Mac Mini Executor Build Plan
_Status: PLAN (not yet built). Author: Claude (Mac Mini session), 2026-06-05._
_Tracking: dev_task `1a0d1354` (umbrella `1717570c`). Canonical system doc: `docs/systems/agent-bridge.md`._

---

## 0. READ THIS FIRST — how we got here (so no session restarts from zero)

This section is the session narrative. If you are a future session, read it before touching anything.

### The arc of the whole bridge (chronological)
1. **Phase 1 (research rail)** — `agent_messages` table + `/api/cron/hermes-bridge` worker. Hermes (Telegram, Mac Mini) drops a research question; a server-side `claude-sonnet-4-6` worker investigates with READ-ONLY tools and writes findings back. Built + shipped. (commit lineage `9040a7c7` → merged to main.)
2. **Phase 2 Slices 1–4** — the action-authorization rail. `approval_queue` table; `propose_action` (worker proposes an action, nothing runs); `approval_list`/`approval_decide`; the server `approval-executor` that runs approved actions (kill-switch `APPROVAL_RAIL_ENABLED`); enum normalization; the proposal formatter. Shipped to production (PRs #82–#88).
3. **Antonio's pivot** — *"what we built is a stupid worker that can't do anything."* He wanted a real three-way conversation (Antonio ↔ Hermes ↔ Claude), not a queue with buttons.
4. **Phases A–D** — threading (`thread_id`, `thread_summaries`), `hermes_instances` heartbeat registry + `/api/cron/hermes-health`, worker codebase read access, thread-type tool routing, prompt provenance, env lanes, batch grouping. Shipped (PRs #89–#92).
5. **WP1** — `approval_queue.confirmation_code` (6-digit, typed by Antonio to approve) + the **Operating-Agent pull rail**: `hermes_heartbeat`, `approval_claim`, `approval_complete` MCP tools. The intent: Hermes (not the server) becomes the thing that runs approved actions. Shipped (PR #93).
6. **WP2** — `thread_create` MCP tool + optional `thread_id` on `agent_msg_send`. Activates the dormant thread layer. Shipped (PR #94).
7. **Handoff doc** (`docs/mac-mini-hermes-handoff.md`, commit `4c5ae973`) — written by the MacBook ("Dispatch") session telling the Mac Mini session to: add 5 MCP tools to Hermes, build a 60s cron that heartbeats + shows proposals on Telegram + **claims and executes approved actions locally**, parse APPROVE/REJECT, then (after verification) turn the server executor OFF so Hermes is the sole executor.

### What THIS session (2026-06-05, Mac Mini) did
- Read the handoff, then **challenged it repeatedly at Antonio's insistence** (R101). Cycled through several designs (Supabase realtime push; three launchd daemons; server-stays-executor) and rejected each after stress-testing.
- **Read the actual shipped code** (not just the doc) on `origin/main`: `lib/mcp/tools/agent-approvals.ts`, `lib/ai-agent/approval-executor.ts`, `lib/ai-agent/approvable-tools.ts`, the three migrations, the canonical `docs/systems/agent-bridge.md`, and the **current Mac Mini `~/.hermes/config.yaml` + `USER.md`**.
- Antonio chose the execution model via a direct decision: **"Both — Mac Mini primary, server as backup."** (Approved actions fire only when the Mac Mini is awake and pulls them; if it's offline past a timeout, the server executor takes over so nothing gets stuck.)
- Antonio's governing instruction for this plan: *"We are not creating a plan to save time, or to write less code. We are creating a plan that must work forever and be reliable, safe, and not create problems… the best solution with the best implementation and the best features."*

### THE KEY FINDING (the reason this plan exists)
The handoff says *"Hermes claims an approved action and executes the tool locally."* **It cannot, as built.** Verified against code:
- `approval_queue.tool_name` stores the **in-dashboard agent** tool names from `lib/ai-agent/tools.ts` — the 12 in `APPROVABLE_TOOL_NAMES`: `create_task, update_task, update_account_notes, update_contact, update_service, advance_service_stage, send_email, drive_move, drive_upload_file, gmail_get_attachments, log_conversation, save_memory`.
- The server `approval-executor` runs these via `executeTool(tool_name, params)` — the path tested end-to-end 12/12 (Slice 3).
- **Hermes on the Mac Mini does NOT have `executeTool`.** Its MCP `tools.include` has *different* tools with *different* param shapes (`gmail_send`, `crm_update_record`, `drive_move`, …). Mapping examples: `send_email`→`gmail_send` (different params), `log_conversation`→`conv_log`, `save_memory`→**no MCP equivalent in Hermes's list**, `create_task`→**no direct MCP equivalent in Hermes's list**.
- So `approval_claim` hands Hermes a row it has **no reliable, complete way to execute**. Making Hermes (sonnet) translate 12 tools at runtime is fragile, untested, and unmaintainable — and impossible for the tools with no equivalent. **The WP1 pull tools shipped without a working execution mechanism.**

### THE RESOLUTION (what this plan builds)
Honor Antonio's choice (Mac Mini primary, server backup) but **fix the execution mechanism**: the Mac Mini decides *WHEN* to run; the **server** does the *RUNNING* via the already-tested `executeTool` path. Add ONE server-side MCP tool, `approval_execute(id)`, that runs a row the Mac Mini just claimed, using the same code the server executor uses. The Mac Mini flow becomes: `approval_claim` → `approval_execute(id)` → done. No translation layer, no fragility, hardware-gated (nothing runs unless the Mac Mini pulls).

---

## 1. Goal & success definition

**Goal:** Antonio, from his phone on Telegram, sees every proposed action instantly with a 6-digit code, types `APPROVE <id> <code>` or `REJECT <id> <reason>`, and the action runs — primarily driven by his Mac Mini, with the server as an automatic backup if the Mac Mini is offline. Reliable forever; no double-execution; no fragile per-tool translation.

**Done when:**
- A proposed action reaches Antonio on Telegram in <2s (server push) AND is visible via `approval_list`.
- Antonio approves with the code → the Mac Mini claims it → the action runs through the tested server path → outcome reported back on Telegram + CRM.
- With the Mac Mini **off**, the same approval still executes via the server backup within the grace window.
- With the Mac Mini **on**, the server backup never double-runs an action the Mac Mini already ran (atomic claim proven under race).
- All sandbox scenarios (§7) pass; then promoted to production behind the existing kill switch.

---

## 2. Architecture (target state)

```
PROPOSE                         NOTIFY                         DECIDE                        EXECUTE
worker/Claude proposes  ─┐
  propose_action          │
  → approval_queue(pending)│──► server push to Telegram ──► Antonio reads on phone
  + 6-digit code          │     (NEW: on propose, server      types APPROVE <id> <code>
                          │      calls Telegram Bot API)            │
                          │                                        ▼
                          │                               Hermes (Mac Mini) parses,
                          │                               calls approval_decide(approve, code)
                          │                                        │ pending→approved
                          │                                        ▼
                          │                          ┌─────── Mac Mini PRIMARY ───────┐
                          │                          │ Hermes claim-loop (every ~15s):│
                          │                          │  approval_claim(instance)      │
                          │                          │   approved→executing            │
                          │                          │  approval_execute(id)  ◄── NEW  │
                          │                          │   (server runs executeTool,     │
                          │                          │    finalizes, notifies)         │
                          │                          └────────────────────────────────┘
                          │                                        │
                          │                          ┌─────── Server BACKUP ──────────┐
                          │                          │ approval-executor cron (5 min): │
                          │                          │  ONLY if Mac Mini stale/offline │
                          │                          │  AND row older than grace window│
                          │                          │  → same executeTool path        │
                          │                          └────────────────────────────────┘
                          ▼
                  Phase B push-to-admin + CRM team-chat mirror (already exists, stays on)
```

**Three independent notification channels** (defense in depth, all already exist except Telegram-on-propose): Telegram (NEW server push), web push to admin (Phase B), CRM team-chat mirror (Phase B). One failing never loses the proposal.

---

## 3. The execution-model change (the heart of this plan)

### 3a. NEW server tool: `approval_execute(id)` — `lib/mcp/tools/agent-approvals.ts`
- Input: `id` (a row the caller just claimed via `approval_claim`, so it is `status='executing'` with `claimed_by=<instance>`).
- Logic (reuses existing tested pieces — do NOT duplicate executor logic):
  1. Read the row; require `status='executing'` (else no-op message — idempotent/race-safe).
  2. Re-check `computeParamsHash(params)` vs stored `params_hash` → mismatch ⇒ `failed`/`error_text='integrity'` + `emitApprovalOutcome`, never runs. (Same guard `approval_claim` already does — this is the second line.)
  3. Run via the **same tested path**: `executeTool(tool_name, params)` then `interpretToolResult(raw)` (import from `lib/ai-agent/approval-executor.ts` — export it if not already) so an error-shaped result is `failed`, not `executed`.
  4. Finalize: `status='executed'|'failed'`, `result`/`error_text`, `executed_at`, `executed_by=<claimed_by>`, `notification_sent=false` then `emitApprovalOutcome(...)`.
  5. Guarded UPDATE `WHERE id=X AND status='executing'` (so a concurrent `approval_complete` or cron recovery can't double-finalize).
- **Why this and not "Hermes runs the tool":** the credentials + the 12 tested tool implementations live server-side. `approval_execute` keeps RUN reliability on the proven path while the DECISION-to-run originates from the Mac Mini (hardware-gated). Net: best of both.
- **Note on `approval_complete`:** WP1's `approval_complete(id,status,result)` stays as the manual/fallback closer. `approval_execute` supersedes the "Hermes runs it then calls complete" flow for the 12 server-side tools; `approval_complete` remains for any future genuinely-local action a later phase adds.

### 3b. Make the server executor BACKUP, not primary — `lib/ai-agent/approval-executor.ts` + `lib/mcp/tools/agent-approvals.ts`
Today `approval_decide(approve)` calls `fireExecutorTrigger(id)` → the server runs the action **instantly**, so the server wins. For Mac-Mini-primary we must make the server defer:
- **Remove the instant trigger on approve** (delete/guard the `fireExecutorTrigger` call in `approval_decide`). Approve just flips `pending→approved`; it does NOT fire the server.
- **Server scan becomes backup-only.** In `runExecutorScan`, the "execute approved rows" step must additionally require:
  - the row has been `approved` for longer than a **grace window** `BACKUP_GRACE_MS` (e.g. 3 min — survives a sleeping Mac Mini's next wake/claim), AND
  - the primary Mac Mini instance is **stale/offline** per `hermes_instances` (reuse `isInstanceStale` from `lib/ai-agent/hermes-health.ts`, instance id `hermes-mac-mini`), OR the grace window is exceeded regardless (so a never-online Mac Mini can't strand approvals forever).
  - Decision rule (explicit, testable, pure): `serverShouldBackstop(row, instanceRow, now)` = `approvedAge > BACKUP_GRACE_MS && (instanceStale || alwaysAfter(LONG_STRAND_MS))`. Put this in a pure function with unit tests.
- **Crash-recovery + expiry stay unchanged** (recover `executing` > 10 min; expire `pending` past `expires_at`).
- **Kill switch stays:** `APPROVAL_RAIL_ENABLED` still gates the server executor. The Mac Mini path (`approval_execute`) needs its OWN consideration — see §6 risk (kill switch must not silently block the Mac Mini path, or must be deliberately shared).

### 3c. Server push to Telegram on propose — NEW, server-side
- On a fresh `propose_action` insert, in addition to the existing Phase B `sendApprovalNotification(row,'proposed')`, send a Telegram message to Antonio (chat `307359927`) via the Bot API with the formatted proposal (`formatApprovalProposal` already renders code + `APPROVE <id> <code>`).
- Implement as a best-effort module `lib/ai-agent/telegram-notify.ts` (never throws; swallow + log), called from the same place Phase B fires. Needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_APPROVAL_CHAT_ID` in Vercel env (NEW server secrets).
- **Why server-push not Mac-Mini-poll for notify:** the server never sleeps and has no local state to lose, so the "you have a proposal" message is instant and reliable even if the Mac Mini is asleep. The Mac Mini's job is the *reply* path (parse APPROVE/REJECT) + the *execute* path (claim→execute), not first-notification.

---

## 4. The Mac Mini side (Hermes wiring)

### 4a. Config — `~/.hermes/config.yaml`
- **Back up first** (`cp config.yaml config.yaml.bak-pre-macmini-executor`). The current file (14KB, rebuilt 2026-06-04, points at **production** `td_production`) already includes `agent_msg_send, approval_list, approval_decide` + a broad CRM/Drive/Gmail set.
- Add to `td_production.tools.include`: `hermes_heartbeat, approval_claim, approval_complete, approval_execute, thread_create, thread_search`.
- **Environment decision (ASK ANTONIO):** today Hermes points at **production** MCP. The whole rail + executor is being changed; this MUST be validated in **sandbox** first (R104). Decide: temporarily point Hermes at the sandbox deployment for E2E, OR run the rail E2E headless (tsx scripts) and only flip Hermes config after production promotion. Do NOT do first-time E2E of a brand-new execution path against production.

### 4b. The claim-and-execute loop
- Preferred mechanism: a dedicated **launchd LaunchAgent** running a small Node script (`~/.hermes/agents/approval-runner.js`) — NOT folded into the Hermes gateway, so a crash in one doesn't take the other down, and it restarts independently. (Investigate Hermes's native `cronjob` toolset as an alternative, but a standalone launchd job is the stable default.)
- Loop (~15s):
  1. `hermes_heartbeat('hermes-mac-mini')`.
  2. `approval_claim('hermes-mac-mini')` → if a row returns, `approval_execute(row.id)`; else skip.
  - It does NOT notify (server push handles that) and does NOT decide (Antonio decides via Telegram → `approval_decide`).
- **macOS sleep:** the Mac Mini must not sleep or the heartbeat gaps + claims stop. Set `sudo pmset -a sleep 0 disablesleep 1` (or `caffeinate -s` under the LaunchAgent). Document + verify; this is load-bearing for "Mac Mini primary."

### 4c. Telegram APPROVE/REJECT handling — Hermes (gateway, via USER.md)
- Hermes already receives Telegram messages. USER.md teaches it to parse `APPROVE <short-id> <code>` → `approval_decide(id,'approve',confirmation_code=<code>)` and `REJECT <short-id> <reason>` → `approval_decide(id,'reject',note=<reason>)`.
- Discipline (NON-NEGOTIABLE, same tier as gmail_send): never invent a code; read it from Antonio's message; never auto-approve; show nothing as approved unless Antonio typed the code.

### 4d. USER.md — `~/.hermes/memories/USER.md`
Currently Phase-1 state (business orientation + gmail_send discipline only). Add sections:
- **Approval Rail** — how proposals appear, the APPROVE/REJECT grammar, confirmation-code discipline, never auto-approve.
- **Execution** — the runner claims + asks the server to execute; Hermes does not re-run actions itself.
- **Thread management** — open a `thread_create` per investigation, tag `agent_msg_send` with the `thread_id`.
- **New tools** — `hermes_heartbeat, approval_claim, approval_execute, approval_complete, thread_create, thread_search`.

---

## 5. Build order (all sandbox-first per R104/R105)

> Pre-req: this Mac Mini's repo is **behind origin/main**. Sync first: rebase the working branch onto `origin/main` (the feature branch `feat/flexible-formation-lifecycle` already carries Phase-1; reconcile, or branch fresh off `origin/main` for the server work). Do NOT build server changes on the stale tree.

1. **Branch** off `origin/main` (fresh, e.g. `feat/macmini-executor`).
2. **Server: `approval_execute(id)`** in `agent-approvals.ts` (+ export `interpretToolResult` from `approval-executor.ts` if needed). Unit tests.
3. **Server: executor deferral** — pure `serverShouldBackstop()` + wire into `runExecutorScan`; remove `fireExecutorTrigger` from `approval_decide(approve)`. Unit tests (defer when Mac Mini fresh; backstop when stale; long-strand failsafe).
4. **Server: Telegram-on-propose** — `lib/ai-agent/telegram-notify.ts` (best-effort) wired beside the Phase B propose notification. Unit test (formats; never throws; no token → skips).
5. **Tests + build green** (`npm run lint && npm run test:unit && npm run build`), plus a real-DB sandbox E2E script `scripts/test-macmini-executor.ts` mirroring the prior phases' tsx E2E (propose → approve-with-code → claim → approval_execute → executed + callback; and the backstop path with a simulated-stale instance).
6. **Antonio reviews diff → ship-it** → push → production migration N/A (no schema change expected; confirm) → set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_APPROVAL_CHAT_ID` in Vercel → verify crons.
7. **Mac Mini wiring** — back up config; add the 6 tools; add USER.md sections; create the launchd runner + heartbeat; disable sleep; restart Hermes.
8. **Cutover** — with the Mac Mini runner verified claiming+executing, the server is already backup-only by construction (step 3). Confirm `APPROVAL_RAIL_ENABLED` posture for both paths (§6).
9. **Verify** §7 scenarios in sandbox, then the same against production with one low-risk action (e.g. `log_conversation`) before trusting `send_email`.

---

## 6. Risks & safety (track every one)

1. **Kill-switch coverage.** `APPROVAL_RAIL_ENABLED` gates the *server* executor. The NEW `approval_execute` (Mac Mini path) must be deliberately decided: either it also respects the switch (so one flag stops ALL execution — safest) or it's independently gated. DECIDE + document; do not leave it implicit.
2. **Double-execution during transition.** Until step 3 ships, the server still instant-fires on approve AND the Mac Mini could claim — atomic claim guarantees one winner, but verify under race in sandbox before trusting. After step 3, the server defers, so the window closes.
3. **macOS sleep strands the primary.** If the Mac Mini sleeps and the grace/strand failsafe is too long, approvals sit. Tune `BACKUP_GRACE_MS` / `LONG_STRAND_MS`; disable sleep; the hermes-health monitor must reliably mark the instance stale.
4. **Telegram bot token in Vercel = new server secret.** Rotate/leak surface in one more place. Store only in Vercel env; never in repo. (Hermes already holds the same token on the Mac Mini — same token, two homes; note for rotation.)
5. **Approve-after-execute.** If the server backstop already ran a row and Antonio then types APPROVE, `approval_decide` requires `status='pending'` → it no-ops with a message. Confirm the message is clear ("already executed"), not a silent failure.
6. **Hermes points at production today** with direct write tools (`crm_update_record`, `gmail_send`, `drive_delete`) OUTSIDE the approval rail. This plan does not fix that (Phase 3 re-tiering), but flag it: today the only guard on those is USER.md discipline. Do not expand that surface here.
7. **`save_memory`/`create_task` etc. with no Mac-Mini MCP equivalent** — this is exactly why `approval_execute` runs server-side. Never reintroduce "Hermes runs the tool itself" for the 12.
8. **Stale repo tree** — building on the behind branch would silently miss WP1/WP2 code. Sync first (§5 pre-req).
9. **Config was regenerated externally (2026-06-04).** Treat `~/.hermes/config.yaml` as not-authored-by-us; back up before edit; diff after.

---

## 7. Sandbox test scenarios (must all pass before production)

1. **Propose → Telegram push** arrives <2s with code + APPROVE/REJECT grammar; row visible in `approval_list(pending)`.
2. **Approve with correct code** → `pending→approved`; server does NOT instant-run (deferral verified — `claimed_by` not `approval-executor`).
3. **Mac Mini claim → approval_execute** → `executing→executed`; `executed_by='hermes-mac-mini'`; outcome callback in `agent_messages`; CRM mirror row.
4. **Approve with wrong/missing code** → not approved; row stays pending; clear error.
5. **Reject** → `pending→rejected`; callback written; no execution.
6. **Mac Mini OFFLINE backstop** — simulate stale `hermes_instances` row; approve; after grace window the server scan executes via the tested path; `executed_by='approval-executor'`.
7. **Race** — fire Mac Mini claim + server backstop at the same row simultaneously → exactly one wins (atomic claim); the loser no-ops; no double side effect.
8. **Integrity mismatch** — tamper stored params after approve → `approval_execute` and the server both refuse, mark `failed('integrity')`, never run.
9. **All 12 tools** through propose→approve→approval_execute against sandbox (mirror `scripts/test-approval-rail-s3.ts`; `SANDBOX_MODE=1` mocks external sends). Expect 11 executed + `gmail_get_attachments` failed-by-design.
10. **Kill switch** behaviour per the §6.1 decision (whichever path it gates returns disabled cleanly).
11. **Heartbeat** — runner writes `hermes_instances` every ~60s; `/api/cron/hermes-health` flips it offline when the runner stops.
12. **Telegram-notify failure isolation** — with no token, propose still succeeds and queues; web-push + CRM mirror still fire.

---

## 8. Open decisions to confirm with Antonio before building
- **§4a env:** run the brand-new execution path E2E in **sandbox** first (point Hermes at sandbox, or headless tsx) — confirm. (Default: yes, sandbox-first, non-negotiable per R104.)
- **§6.1:** should `APPROVAL_RAIL_ENABLED` gate BOTH the server and the Mac Mini execution paths (one master switch — recommended), or only the server?
- **Grace tuning:** `BACKUP_GRACE_MS` (default 3 min) + `LONG_STRAND_MS` failsafe (default e.g. 30 min) — acceptable?
- **Sleep policy:** OK to disable Mac Mini sleep (`pmset disablesleep 1`)? Required for "Mac Mini primary" to be real.

---

## 9. Pointers (so a future session verifies, not re-derives)
- Server approval tools: `lib/mcp/tools/agent-approvals.ts` (`approval_list/decide/`, `hermes_heartbeat/claim/complete`, +NEW `approval_execute`).
- Server executor: `lib/ai-agent/approval-executor.ts` (`claimApproval`, `executeApprovalRow`, `interpretToolResult`, `runExecutorScan`).
- Allow-list + hash: `lib/ai-agent/approvable-tools.ts` (12 `APPROVABLE_TOOL_NAMES`, `computeParamsHash`, `APPROVABLE_TOOL_CONSTRAINTS`).
- Health: `lib/ai-agent/hermes-health.ts` (`isInstanceStale`) + `/api/cron/hermes-health`.
- Formatter: `lib/ai-agent/format-approval-proposal.ts`.
- Notifications (Phase B): `lib/ai-agent/approval-notifications.ts` (`emitApprovalOutcome`, `sendApprovalNotification`).
- Migrations: `20260604-1100-approval-queue.sql`, `20260604-2200-phase-a-core.sql`, `20260604-2330-approval-confirmation-code.sql`.
- Canonical doc: `docs/systems/agent-bridge.md` (Phase 1 → WP2, all gotchas). Handoff: `docs/mac-mini-hermes-handoff.md`.
- Mac Mini Hermes: `~/.hermes/config.yaml` (rebuilt 2026-06-04, points at production `td_production`), `~/.hermes/memories/USER.md` (Phase-1 state).
