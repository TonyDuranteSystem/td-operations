# MCP Tool Server
_Last verified against code: 2026-06-04 — Claude (added agent-approvals group — approval_list — for the bridge approval rail Phase 2 Slice 1)_

## What it is
The MCP server that exposes TD Operations to Claude (Claude Code + the Claude.ai connector) as callable tools. One endpoint, dual auth, and ~218 tools across 42 active groups. This doc is about the *server infrastructure*; each tool's behaviour is documented in its subsystem doc.

## The single endpoint
`app/api/[transport]/route.ts` handles all MCP traffic via `createMcpHandler` (`mcp-handler`):
- `POST/GET/DELETE /api/mcp` — Streamable HTTP (messages / SSE stream / session end).
- Legacy `GET /api/sse` + `POST /api/message`.
- **Auth (dual):** Bearer token (`TD_MCP_API_KEY`) for Claude Code; OAuth 2.1 access token for the Claude.ai connector (see `auth-oauth.md`).

## How tools are registered (and the source-of-truth rule)
- Each tool file exports a `register<Area>Tools(server)` function; `route.ts` imports it and calls it.
- **`route.ts` is the ONLY source of truth for which tools are active.** A tool file can exist but be inactive (commented import/call). **Never count `server.tool()` across files** — count uncommented `register*Tools` calls in `route.ts`:
  `grep -v '//' app/api/[transport]/route.ts | grep 'register.*Tools'` → re-run for the live number (the "41 groups (~217 tools)" figure is from 2026-05-29 and has since grown).
- **Hermes ↔ Claude bridge group (2026-06-03):** `registerAgentMessageTools` (`lib/mcp/tools/agent-messages.ts`) adds 3 tools — `agent_msg_send`, `agent_inbox_list`, `agent_inbox_reply` — over the inter-agent `agent_messages` table. The worker that *answers* those messages is NOT an MCP tool; it lives at `app/api/cron/hermes-bridge` (read-only sonnet). Full subsystem doc: `agent-bridge.md`. `agent_msg_send` carries a mandatory approval rule in its description.
- **Agent approvals group (2026-06-04, Phase 2 Slice 1):** `registerAgentApprovalTools` (`lib/mcp/tools/agent-approvals.ts`) adds 1 read-only tool — `approval_list` — over the `approval_queue` table (proposed actions awaiting Antonio's approval). The bridge worker's `propose_action` tool writes those pending rows; **nothing executes in Slice 1**. Full subsystem doc: `agent-bridge.md`.
- **Adding a tool:** add `server.tool(...)` in the area file → add the import + `register*Tools(server)` call in `route.ts` → update `lib/mcp/instructions.ts` → mirror `docs/claude-connector-system-instructions.md`.
- **Removing a tool:** delete the file or move it to `lib/mcp/tools/deprecated/` (as QB was, R097) — never leave dead tool files (they cause wrong counts/confusion).

## ⚠️ Two MCP connections in Claude Code (R096)
_Source: this is an operational rule in CLAUDE.md (R096), confirmed by `.mcp.json` (defines the `td-ops-sandbox` connection). It is NOT encoded in `route.ts` — `route.ts` only implements the server's dual **auth** (Bearer + OAuth). The two connections are a Claude-Code client-config convention, not server code._
- `mcp__td-ops-sandbox__*` → **sandbox** Supabase — use for development (building/testing/verifying sandbox).
- `mcp__af7d85f2-*` → **production** Supabase (the DXT plugin) — use for operations (real clients).
- **EXCEPTION:** `session_checkpoint` + `dev_task_*` always use the production connection (work tracking must persist).
- **Critical:** the `af7d85f2` connection is **hardwired to production** — the sandbox enforcement (`.env.local`, `.vercel/project.json`, the supabase-admin ref check) does NOT apply to MCP calls. Every `mcp__af7d85f2-*__execute_sql` hits production. For sandbox DB work use `mcp__td-ops-sandbox__*` or `psql`.

## Cross-cutting MCP infrastructure (`lib/mcp/`)
- `instructions.ts` → `SERVER_INSTRUCTIONS` — sent in the MCP `initialize` handshake (the assistant's standing rules). Mirror lives in `docs/claude-connector-system-instructions.md`.
- `safe-send.ts` → `safeSend()` — the R037 send pattern (idempotency check → send → status update after → multi-step tracking). All send tools must use it.
- `reminder.ts` → `addReminderMiddleware()` — injects the 5/10/15 checkpoint reminders into tool responses (the Claude.ai equivalent of the Claude Code hooks).
- `action-log.ts` → `logAction()` — writes an audit trail of MCP write operations to `action_log`.

## Business rules
- **Tool-count source of truth = `route.ts` uncommented registrations** — update counts in `instructions.ts`/docs only after verifying with the grep above.
- **R037** — send tools use `safeSend`. **R051** — subagents write results to Supabase before returning. **R096** — the routing rule above. **R097** — QB tools are removed and **QuickBooks is decommissioned/DEAD** (kill-switch OFF since 2026-05-23); do not restore the tools, re-enable sync, or build on QB.
- Tool *descriptions* are the documentation — keep them detailed (prerequisites, cross-references).

## How it's built — key files & tables
- Files: `app/api/[transport]/route.ts` (entry + registrations), `lib/mcp/{instructions,safe-send,reminder,action-log}.ts`, `lib/mcp/tools/*` (44 files), `docs/claude-connector-system-instructions.md`.
- Tables: `action_log` (audit), `oauth_*` (connector auth), `session_checkpoints`.

## Gotchas, invariants & past bugs
- **Don't trust a tool file's existence** — only `route.ts` registration makes a tool active. Counting `server.tool()` across files gives the wrong number.
- **MCP bypasses sandbox safety (R096)** — there is no PreToolUse hook on MCP except `production-write-guard`; `af7d85f2` = production always.
- **Update `instructions.ts` + the mirror doc** whenever tools change, or the connector's standing instructions drift from reality.
- **Deleted tools must leave no file behind** — orphan files in `lib/mcp/tools/` mislead the next session's count.

## How to verify current state
- Active tool groups: `grep -v '//' "app/api/[transport]/route.ts" | grep 'register.*Tools'`.
- Read `lib/mcp/instructions.ts` (the standing instructions) and `lib/mcp/safe-send.ts` (the send contract).
- Note (R096): sandbox via `mcp__td-ops-sandbox__*` / `psql`; `mcp__af7d85f2-*` hits production.
