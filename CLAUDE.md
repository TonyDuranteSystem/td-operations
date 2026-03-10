# TD Operations — Claude Code Rules

## Identity
You are working on **td-operations**, the monolithic Next.js codebase for Tony Durante LLC.
This repo contains: MCP server (78 tools), CRM dashboard, OAuth 2.1, offer system, API routes.

## Architecture
- **Supabase** (`ydzipybqeebtpcvsbtvs`) = Single Source of Truth — all data lives here
- **Google Drive** = Document storage (Shared Drive: `0AOLZHXSfKUMHUk9PVA`)
- **Vercel** = Hosting (Pro plan, 60s timeout)
- **GitHub** = `TonyDuranteSystem/td-operations` (auto-deploy on push)

## Session Start — AUTOMATIC
When Antonio says "riprendiamo", "dove eravamo", "continua", "resume", or starts a new session:
1. `sysdoc_read('session-context')` — system state
2. Run TWO queries on dev_tasks:
   - `SELECT id, title, status, priority, progress_log, updated_at FROM dev_tasks WHERE status IN ('in_progress','todo') ORDER BY updated_at DESC LIMIT 5` — pending work
   - `SELECT id, title, status, progress_log, updated_at FROM dev_tasks WHERE status = 'done' ORDER BY updated_at DESC LIMIT 3` — recently completed (to know what was JUST done)
3. Check `git status` and recent commits — code state
4. Present a summary organized as:
   - "Ultimo lavoro completato:" — what was just finished (from recent done tasks)
   - "In sospeso:" — what's still pending (in_progress/todo)
   - "Prossimi passi:" — extract from progress_log PENDING entries of the most recent task
   Then ask "Su cosa lavoriamo?"
Do this AUTOMATICALLY without Antonio having to explain what was being worked on.

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

## Anti-Compaction Protocol — MANDATORY

### WHY THIS EXISTS
When the conversation gets long, Claude compresses old messages (compaction).
After compaction, ALL context is lost unless it was saved to Supabase FIRST.
This has already caused 2+ hours of lost recovery time. It WILL happen again if you don't save.

### Rule: Save IMMEDIATELY after EVERY significant action
NOT every 3-5 actions. NOT at end of session. AFTER EACH ONE.
A "significant action" = any commit, deploy, DB change, config change, tool fix, or decision made.

You MUST create/update a `dev_tasks` record via `execute_sql`:
- **IMMEDIATELY AFTER** each significant action (commit, fix, discovery, decision)
- **BEFORE** any `git push` or deploy
- **AT END** of every session, even if work is incomplete

### Rule: Delegate heavy work to subagents
Subagents write results to Supabase BEFORE returning to chat.
This keeps the main conversation light and compaction-resistant.
Use agent templates in `.claude/agents/` for batch ops, audits, reports.
Pattern: agent writes to DB → returns max 10-15 line summary to chat.

How to write to dev_tasks:
```sql
INSERT INTO dev_tasks (title, status, priority, progress_log)
VALUES ('Title', 'in_progress', 'high',
'[{"date":"YYYY-MM-DD","action":"What","result":"Outcome"}]')
RETURNING id;
```
To update existing:
```sql
UPDATE dev_tasks
SET progress_log = '[updated JSON array]', status = 'done', updated_at = now()
WHERE id = 'uuid';
```

### What to save in progress_log
- What was built/changed (files, tools, DB changes)
- What was deployed (commit hash)
- What is PENDING (next steps, blockers, decisions needed)
- Any credentials or config added (reference, not values)

### Recovery after compaction
1. Read this file (CLAUDE.md)
2. `SELECT * FROM dev_tasks WHERE status = 'in_progress' ORDER BY updated_at DESC`
3. Read progress_log to understand what was done
4. `sysdoc_read('session-context')` for system state
5. Resume from last checkpoint

### For operational work (non-dev)
Use `sysdoc_create` with slug `ops-YYYY-MM-DD-topic` to log what was done.

### Subagent pattern
Use `.claude/agents/` templates for batch processing, audits, reports.
Rule: agent writes results to Supabase BEFORE returning. Chat gets compact summary.

### Key tables for dev context
- `dev_tasks` — Issue tracker for development work (NOT client tasks)
- `system_docs` — Session context, project-state, tech-stack
- `knowledge_articles` — Business rules (59 articles)

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
