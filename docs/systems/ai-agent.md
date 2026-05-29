# AI Agent (in-dashboard assistant)
_Last verified against code: 2026-05-29 — Claude (read lib/ai-agent/{providers,tools,system-prompt}.ts, ai-agent route)_

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

## Business rules
- **Staff-only** — clients can never use it; non-admin staff need the `app_settings.ai_agent.enabled_for_team` toggle.
- **20 req/min** rate limit per caller.
- It is a **distinct tool surface** from the MCP server — the two tool sets are maintained separately.

## How it's built — key files & tables
- Files: `app/api/ai-agent/route.ts` (entry + access + rate limit), `app/api/ai-agent/attachment-preview/route.ts`, `lib/ai-agent/{providers,system-prompt,tools}.ts`. Background/architecture: sysdoc `antonio-brain-architecture`.
- Tables: `app_settings` (`ai_agent` toggle), `conversations` (logging), the agent-memory store (`save_memory`/`recall_memories`), plus whatever the tools read/write.

## Gotchas, invariants & past bugs
- **Two different tool worlds** — the AI agent's `lib/ai-agent/tools.ts` (~34 tools) is NOT the MCP server's ~217 tools. A change in one doesn't affect the other; adding an MCP tool does NOT give the dashboard agent that capability (and vice-versa).
- **Provider fallback can change behaviour** — Claude (sonnet-4-6) primary, GPT-4o fallback; outputs/tool-use may differ if it falls back. `provider` is returned in the response so you can tell which ran.
- **`run_sql_query` runs against the deployment's DB** — staff-only, but on production it hits production. Treat it like any production query.
- **Agent memory is separate** from `session_checkpoints` and from Claude Code memory — it's the dashboard agent's own `save_memory`/`recall_memories` store.
- Model `claude-sonnet-4-6` is hardcoded in `providers.ts` — a model change is a code edit there.

## How to verify current state
- Read `lib/ai-agent/providers.ts` (the models + provider order), `lib/ai-agent/tools.ts` (the tool list), `app/api/ai-agent/route.ts` (access gate + rate limit).
- Team access state: `SELECT value FROM app_settings WHERE key='ai_agent';`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
