# TD Operations — Claude Code Rules

## Identity
You are working on **td-operations**, the monolithic Next.js codebase for Tony Durante LLC.
This repo contains: MCP server (78 tools), CRM dashboard, OAuth 2.1, offer system, API routes.

## Architecture
- **Supabase** (`ydzipybqeebtpcvsbtvs`) = Single Source of Truth — all data lives here
- **Google Drive** = Document storage (Shared Drive: `0AOLZHXSfKUMHUk9PVA`)
- **Vercel** = Hosting (Pro plan, 60s timeout)
- **GitHub** = `TonyDuranteSystem/td-operations` (auto-deploy on push)

## Critical Code Rules

### MCP Tools (78 tools in 15 files under `lib/mcp/tools/`)
- NEVER use `execute_sql` for CRM writes — always use `crm_update_record`
- Tool descriptions are the documentation — keep them detailed with prerequisites and cross-references
- Server instructions live in `lib/mcp/instructions.ts` — update when adding/changing tools
- Mirror docs in `docs/claude-connector-system-instructions.md` for reference

### Database
- All schema changes via Supabase Dashboard or `execute_sql` — no local migrations
- RLS enabled on all tables
- Enums defined in DB — check before adding new values

### Auth
- Dual auth: Bearer token (Claude Code) + OAuth 2.1 (Claude.ai)
- OAuth tables: `oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_users`
- Middleware at `middleware.ts` — excludes `/api/oauth/*` and `/.well-known/*`

### Google APIs
- Service Account + Domain-Wide Delegation for Gmail and Drive
- Impersonate `support@tonydurante.us` by default
- `lib/gmail.ts` and `lib/google-drive.ts` handle auth
- `drive_upload` = text files, `drive_upload_file` = binary (PDF, images)

### QuickBooks
- OAuth2 tokens in `qb_tokens` table, auto-refresh
- Realm: `13845050572680403`

## Anti-Compaction Protocol (for development sessions)

### Checkpoint Rule
After completing significant work blocks (feature implemented, bug fixed, tool added):
1. Update the relevant `dev_tasks` record with progress_log entry
2. If the task doesn't exist yet, create one
3. Format: `[{"date": "YYYY-MM-DD", "action": "What was done", "result": "Concise outcome"}]`

### Recovery after compaction
If context compacts mid-session:
1. Read this file (CLAUDE.md) — you're reading it now
2. Check `dev_tasks` on Supabase for active tasks: status='in_progress'
3. Read the task's `progress_log` to understand what was done
4. Resume from last checkpoint

### Subagent pattern (for heavy operations)
Use `.claude/agents/` templates when spawning agents for batch processing, audits, or reports.
Key rule: agent writes results to Supabase BEFORE returning. Chat gets only a compact summary.
Available templates: `batch-processor.md`, `data-auditor.md`, `report-generator.md`.

### Key tables for dev context
- `dev_tasks` — Issue tracker for development work (NOT client tasks)
- `system_docs` — Session context (lean), project-state (milestones), tech-stack (architecture)
- `knowledge_articles` — Business rules (57 articles)

## Business Rules
All business rules live on Supabase in `knowledge_articles` (57) and `sop_runbooks` (14).
Do NOT put business rules in code comments or local files — they belong on Supabase.
Search with `kb_search()` via MCP, or query directly.

## File Structure
```
app/
  api/[transport]/route.ts    <- MCP server entry point
  api/oauth/                  <- OAuth 2.1 endpoints
  api/accounts/               <- Account API routes
  api/inbox/                  <- Unified inbox API
  (dashboard)/                <- CRM dashboard pages
.claude/
  agents/                     <- Subagent prompt templates (anti-compaction)
lib/
  mcp/
    instructions.ts           <- Server instructions (sent in MCP initialize)
    tools/                    <- 15 tool files (crm, doc, drive, gmail, etc.)
  gmail.ts                    <- Gmail API helper (SA + DWD)
  google-drive.ts             <- Drive API helper (SA + DWD)
  supabase-admin.ts           <- Supabase service role client
  types.ts                    <- Shared TypeScript types
docs/
  claude-connector-system-instructions.md <- Mirror of instructions.ts
```

## Communication
Antonio communicates in Italian and English. Match his language. Be direct and efficient.

## Do NOT
- Use Make, Zapier, n8n — all automation via Supabase Edge Functions
- Commit `.env.local` or credentials
- Create README.md or documentation files unless asked
- Push to main without building first (`npm run build`)
