# AI Agent (in-dashboard assistant)
_Last verified against code: 2026-06-04 — Claude (Phase 2 Slice 3 part 1: enum normalization — `lib/ai-agent/enum-normalization.ts` maps flexible input to canonical DB enum values; fixed create_task's invalid `medium`/`Admin` defaults)_

## What it is
A built-in AI chat assistant **inside the CRM dashboard** for staff — it can search the CRM, read Gmail/Drive, and take actions through its own tool set. This is **separate** from Claude Code and the Claude.ai MCP connector: it has its **own** tool definitions (`lib/ai-agent/tools.ts`), not the MCP server's ~217 tools.

## How it works
- **Endpoint:** `POST /api/ai-agent`, body `{ messages: [...] }`, returns `{ content, provider, tools_used }`. Rate-limited to **20 requests/min**.
- **Access:** **admin** (Antonio) always; **team** members only if `app_settings.ai_agent.enabled_for_team = true`; **clients are blocked**.
- **Providers** (`lib/ai-agent/providers.ts`): **Claude `claude-sonnet-4-6` (primary, `ANTHROPIC_API_KEY`)** with **GPT-4o (fallback, `OPENAI_API_KEY`)**. `callAgent()` runs the tool-use loop for whichever provider is configured (Anthropic first). Note: direct provider keys, not the Vercel AI Gateway.
- **System prompt:** `lib/ai-agent/system-prompt.ts` (`SYSTEM_PROMPT`) — embeds business knowledge + instructions.

## The agent's tool set (`lib/ai-agent/tools.ts`)
~34 tools, each a schema + execute function over real Supabase tables:
- **Read:** `search_accounts/contacts/leads/deals/payments/services/tasks/tax_returns/deadlines/portal_messages/kb`, `get_account_detail`, `get_dashboard_stats`, `get_sop`, `run_sql_query`.
- **Write/act:** `create_task`, `update_task`, `update_contact`, `update_account_notes`, `update_service`, `advance_service_stage`, `send_email`.
- **Gmail/Drive:** `gmail_search/read/read_thread/get_attachments`, `drive_search/list_folder/move/upload_file`, `preview_attachment`.
- **Conversation/memory:** `log_conversation`, `save_memory`, `recall_memories` — the agent has **persistent memory** (the "Antonio Brain" — see sysdoc `antonio-brain-architecture`).

## Sibling consumer — Hermes-bridge worker (`lib/ai-agent/worker-tools.ts`, 2026-06-03)
`lib/ai-agent/` now also hosts a **second, separate** model caller for the Hermes ↔ Claude bridge. It is **not** the in-dashboard assistant:
- `WORKER_TOOLS` = a curated **read-only** subset of `tools.ts`'s `AGENT_TOOLS` (search/get/read only — no write/send, and `run_sql_query` is intentionally excluded). `executeWorkerTool()` hard-rejects any name outside the allow-list (defense-in-depth).
- `callWorker()` mirrors `callClaude()` but uses that subset + `WORKER_SYSTEM_PROMPT` (sonnet-4-6). It deliberately does **not** reuse `callAgent()` (which hardcodes the full `AGENT_TOOLS` + dashboard prompt).
- It is driven by the cron worker at `app/api/cron/hermes-bridge`, not `/api/ai-agent`. Full subsystem doc: `agent-bridge.md`.
- **Phase 2 Slice 1 (2026-06-04):** `WORKER_TOOLS` now also includes **`propose_action`** (the one non-read tool — it only QUEUES, never executes). It validates against the allow-list + schema in `lib/ai-agent/approvable-tools.ts` (`APPROVABLE_TOOL_NAMES`, `computeParamsHash`, `validateToolParams`, `APPROVABLE_TOOL_CONSTRAINTS`) and INSERTs a `pending` row into `approval_queue`. `propose_action` is deliberately **not** in `WORKER_READ_ONLY_TOOL_NAMES`. See `agent-bridge.md` for the full rail.
- **Phase 2 Slice 2 (2026-06-04):** `executeTool()` (this file's full dispatcher) is now the **execution path** for approved proposals. `lib/ai-agent/approval-executor.ts` claims an approved `approval_queue` row, re-checks its `params_hash`, then calls `executeTool(tool_name, params)` for real (kill-switch-gated by `APPROVAL_RAIL_ENABLED`); `lib/ai-agent/approval-callback.ts` writes the outcome back to Hermes via `agent_messages`. Note `executeTool` catches its own errors and returns an `{error:…}` string rather than throwing — the executor inspects the result so a logically-failed action is recorded `failed`, not `executed`. Run by `app/api/cron/approval-executor`; decided via the `approval_decide` MCP tool. See `agent-bridge.md`.

## Business rules
- **Staff-only** — clients can never use it; non-admin staff need the `app_settings.ai_agent.enabled_for_team` toggle.
- **20 req/min** rate limit per caller.
- It is a **distinct tool surface** from the MCP server — the two tool sets are maintained separately.

## How it's built — key files & tables
- Files: `app/api/ai-agent/route.ts` (entry + access + rate limit), `app/api/ai-agent/attachment-preview/route.ts`, `lib/ai-agent/{providers,system-prompt,tools}.ts`. Background/architecture: sysdoc `antonio-brain-architecture`.
- Tables: `app_settings` (`ai_agent` toggle), `conversations` (logging), the agent-memory store (`save_memory`/`recall_memories`), plus whatever the tools read/write.

## Enum normalization (`lib/ai-agent/enum-normalization.ts`, 2026-06-04)
Several tool params/filters map to real Postgres ENUM columns (`task_priority`, `task_status`, `task_category`, `service_status`, `conversation_channel`, plus the search-filter enums `account_status`, `payment_status`, `deal_stage`, `lead_status`, `tax_return_status`). An invalid value **throws `22P02` on a write** and **silently returns zero rows on a search**. This module is the single source of truth that maps flexible input (any casing + common synonyms: `medium→Normal`, `todo→To Do`) to the exact canonical DB value, or `null` if unrecognized.
- **Canonical value sets** are verified against `pg_enum` and mirror the migration DDL — keep them in sync if an enum changes.
- **Write paths** (`createTask`, `updateTask`, `updateService`, `advanceServiceStage` auto-tasks, `logConversation`) normalize before insert: `createTask` now defaults `priority→'Normal'` and `category→'Internal'` (the old literals `'medium'`/`'Admin'` were **not valid enum members** and made any category-less create_task throw); `updateTask`/`updateService` return a clear error on an unrecognized enum instead of letting the DB throw.
- **Search filters** normalize then **fall back to the original value** on no-match (an exact match returning nothing is harmless — no behavior regression).
- **Propose path** (`worker-tools.ts::proposeAction`) calls `normalizeToolParams()` BEFORE `validateToolParams` + `computeParamsHash`, so a proposal with `medium`/`todo` is accepted and the stored params (and hash) reflect exactly what executes. The schema `enum:` arrays in `AGENT_TOOLS` are the corrected canonical values (`['Low','Normal','High','Urgent']`, etc.) so propose-time validation still rejects genuine garbage.

## Gotchas, invariants & past bugs
- **Two different tool worlds** — the AI agent's `lib/ai-agent/tools.ts` (~34 tools) is NOT the MCP server's ~217 tools. A change in one doesn't affect the other; adding an MCP tool does NOT give the dashboard agent that capability (and vice-versa).
- **Never re-introduce hardcoded enum literals in `tools.ts`** — route every enum-backed param/filter through `enum-normalization.ts`. The `create_task` `'medium'`/`'Admin'` defaults were a live break (invalid enum members → insert threw). Canonical values live in one place by design.
- **Provider fallback can change behaviour** — Claude (sonnet-4-6) primary, GPT-4o fallback; outputs/tool-use may differ if it falls back. `provider` is returned in the response so you can tell which ran.
- **`run_sql_query` runs against the deployment's DB** — staff-only, but on production it hits production. Treat it like any production query.
- **Agent memory is separate** from `session_checkpoints` and from Claude Code memory — it's the dashboard agent's own `save_memory`/`recall_memories` store.
- Model `claude-sonnet-4-6` is hardcoded in `providers.ts` — a model change is a code edit there.

## How to verify current state
- Read `lib/ai-agent/providers.ts` (the models + provider order), `lib/ai-agent/tools.ts` (the tool list), `app/api/ai-agent/route.ts` (access gate + rate limit).
- Team access state: `SELECT value FROM app_settings WHERE key='ai_agent';`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
