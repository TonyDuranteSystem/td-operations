# TD Operations — Claude Code Rules

## Identity
You are working on **td-operations**, the monolithic Next.js codebase for Tony Durante LLC.
This repo contains: MCP server (78 tools), CRM dashboard, OAuth 2.1, offer system, API routes.

## Architecture
- **Supabase** (`ydzipybqeebtpcvsbtvs`) = Single Source of Truth — all data lives here
- **Google Drive** = Document storage (Shared Drive: `0AOLZHXSfKUMHUk9PVA`)
- **Vercel** = Hosting (Pro plan, 60s timeout)
- **GitHub** = `TonyDuranteSystem/td-operations` (auto-deploy on push)

### Domains (established 2026-03-17)
Four domains point to the same Vercel deployment:
- `app.tonydurante.us` — **CLIENT-FACING**: all forms, offers, leases, OA, tracking pixels. Use `APP_BASE_URL` from `lib/config.ts`.
- `portal.tonydurante.us` — **CLIENT PORTAL**: where clients log in to see their services, documents, invoices, chat. Use `PORTAL_BASE_URL` from `lib/config.ts`.
- `td-operations.vercel.app` — **INTERNAL**: OAuth issuer, QB callback, CRM dashboard. NEVER send to clients.
- `offerte.tonydurante.us` — **LEGACY**: old offer links still work. New links use `app.tonydurante.us`.

### Two Products in One Repo — Know the Difference
| Term | What it is | Domain | Code location | Who uses it |
|------|-----------|--------|---------------|-------------|
| **CRM Dashboard** | Internal ops dashboard for Antonio & Luca | `td-operations.vercel.app` | `app/(dashboard)/`, `components/tasks/`, `components/accounts/` | Staff only |
| **Client Portal** (or just "portal") | Client-facing app where clients log in | `portal.tonydurante.us` | `app/portal/`, `lib/portal/`, `components/portal/` | Clients |

When Antonio says "portal" or "client portal" → he means the client-facing portal, NOT the CRM dashboard.
When Antonio says "dashboard" or "CRM" → he means the internal ops dashboard.

### Work Discipline — MANDATORY
1. **Plan first, build second.** Before writing code, create a complete plan with every step (code, DB, env vars, DNS, testing). Get approval. Then execute in order.
2. **Finish one thing completely before starting the next.** A feature is NOT done until: code works, env vars are set, DB changes applied, tested, and verified. Never declare "done" with open blockers.
3. **Group related work.** If a feature needs env vars, DB changes, and code — do all of them together, not scattered across the session.
4. **Stay on scope.** If working on the portal, don't bring up the CRM dashboard, MCP tools, or other projects unless asked. Focus on what Antonio asked for.
5. **Be honest about what's actually done vs what's just code pushed.** Code pushed ≠ feature working. A feature works when Antonio can use it.

**Rules**:
- All client-facing URLs MUST use `APP_BASE_URL` from `lib/config.ts` — NEVER hardcode domains
- The `.husky/pre-push` hook blocks hardcoded domains — only `lib/config.ts` is exempt
- OAuth ISSUER and QB_REDIRECT_URI stay on `td-operations.vercel.app` (changing would break auth)
- NEVER remove any domain from Vercel — old links must always work
- All URLs, tokens, and slugs must be in English

## Session Start — AUTOMATIC
When Antonio says "riprendiamo", "dove eravamo", "continua", "resume", or starts a new session:
1. `sysdoc_read('session-context')` — system state (contains pointers to other docs)
2. If working on Formation/Onboarding/Lease → `sysdoc_read('workflow-roadmap')` — definitive workflows + implementation checklist
3. Run TWO queries on dev_tasks:
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

### MCP Tools (147 tools in 29 files under `lib/mcp/tools/`)
- NEVER use `execute_sql` for CRM writes — always use `crm_update_record`
- Tool descriptions are the documentation — keep them detailed with prerequisites and cross-references
- Server instructions live in `lib/mcp/instructions.ts` — update when adding/changing tools
- Mirror docs in `docs/claude-connector-system-instructions.md` for reference

### MCP Tool Counting — Source of Truth
The ONLY source of truth for active tools is `app/api/[transport]/route.ts`.
- **NEVER** count `server.tool()` across all files — some files may exist but not be registered
- Only files with an **uncommented** `import` AND **uncommented** `register*Tools(server)` call are active
- Commented imports = REMOVED tools. The file may still exist but those tools are NOT active
- Before updating any tool count (instructions.ts, skill, docs), verify with:
  ```bash
  grep -v '//' app/api/\[transport\]/route.ts | grep 'register.*Tools'
  ```
- When removing tools: DELETE the source file (or move to `/deprecated`). Never leave dead tool files — they cause confusion across machines and incorrect counts.

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

### Forms (Client Data Collection)
- All forms follow the same pattern: email gate → multi-step form → submit
- Forms: `formation-form`, `onboarding-form`, `tax-form`, `lease`, `banking-form`
- **Admin Preview**: Append `?preview=td` to ANY form URL to skip the email gate
  - Shows an amber "ADMIN PREVIEW" badge at the top
  - Does NOT trigger `trackOpen` (no false "opened" status in DB)
  - For lease, also skips access code validation
- **MANDATORY RULE**: When creating or modifying a form, ALWAYS provide Antonio the `?preview=td` link for testing BEFORE sending to the client. Never send a form to a client without Antonio testing it first.
- **When building new forms**: Include the `?preview=td` bypass from the start. Pattern:
  ```
  const searchParams = useSearchParams()
  const adminMode = searchParams.get('preview') === 'td'
  if (adminMode) { setIsAdmin(true); setVerified(true); return }
  ```

### Send Operations — safeSend Pattern (MANDATORY)
Every MCP tool that sends something (email, notification) and updates a DB status MUST use `safeSend()` from `lib/mcp/safe-send.ts`. This enforces:
1. **Idempotency check** — skip if already sent
2. **Send FIRST** — actual email/notification before any status update
3. **Status updates AFTER** — DB updates only after send succeeds
4. **Multi-step tracking** — each post-send step tracked (ok/error)

**NEVER** update a record's status to "sent" before the actual send operation. If the send fails, the record would be incorrectly marked as sent.

Pattern:
```typescript
import { safeSend } from "@/lib/mcp/safe-send"

const result = await safeSend({
  idempotencyCheck: async () => { /* return { alreadySent: true, message } or null */ },
  sendFn: async () => { /* actual send — gmailPost, etc. */ },
  postSendSteps: [
    { name: "update_status", fn: async () => { /* DB update */ } },
    { name: "save_tracking", fn: async () => { /* tracking */ } },
  ],
})
```

Tools using this pattern: `lease_send`, `offer_send`. Future send tools MUST follow this.

## Anti-Compaction Protocol — MANDATORY

### WHY THIS EXISTS
When the conversation gets long, Claude compresses old messages (compaction).
After compaction, ALL context is lost unless it was saved to Supabase FIRST.
This has already caused 2+ hours of lost recovery time. It WILL happen again if you don't save.

### Automatic Protection (hooks in `.claude/settings.json`)
You have 4 hooks that fire automatically — you don't need to remember, the system reminds you:
1. **PostToolUse** — Counts every tool call. After 5/10/15 calls without saving, you get a 🟡/🟠/🔴 reminder. Script: `.claude/hooks/checkpoint-counter.sh`. Counter resets when you call `session_checkpoint` or save to `dev_tasks`.
2. **PreCompact** — Fires BEFORE context compaction. This is your LAST CHANCE to save. Save everything with specific details (files, IDs, values, next steps).
3. **Stop** — Fires when you finish responding. Checks if you made significant changes and reminds you to save.
4. **SessionStart** — Fires at session start. Reads `session-context`, queries `dev_tasks`, presents summary.

### How to save (two methods)
**PREFERRED — `session_checkpoint` via MCP** (one call, resets PostToolUse counter):
```
session_checkpoint({summary: "what you did", next_steps: "what's pending"})
```
**FALLBACK — `dev_tasks` via `execute_sql`** (for dev work needing detailed progress_log):
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

### Rule: Save IMMEDIATELY after EVERY significant action
NOT every 3-5 actions. NOT at end of session. AFTER EACH ONE.
A "significant action" = any commit, deploy, DB change, config change, tool fix, or decision made.
The PostToolUse hook will remind you, but don't wait for the reminder — save proactively.

### What to save
- What was built/changed (files, tools, DB changes)
- What was deployed (commit hash)
- What is PENDING (next steps, blockers, decisions needed)
- Any credentials or config added (reference, not values)
- Be SPECIFIC: file paths, line numbers, IDs, exact values — after compaction this is all you have.

### Recovery after compaction
1. Read this file (CLAUDE.md)
2. `SELECT * FROM dev_tasks WHERE status = 'in_progress' ORDER BY updated_at DESC`
3. Read progress_log to understand what was done
4. `sysdoc_read('session-context')` for system state
5. Resume from last checkpoint — do NOT ask Antonio to repeat information.

### For operational work (non-dev)
Use `sysdoc_create` with slug `ops-YYYY-MM-DD-topic` to log what was done.

### Subagent pattern
Use `.claude/agents/` templates for batch processing, audits, reports.
Rule: agent writes results to Supabase BEFORE returning. Chat gets compact summary.

### Key tables for dev context
- `dev_tasks` — Issue tracker for development work (NOT client tasks)
  - **REGOLA**: Prima di INSERT su dev_tasks, fare SELECT per verificare che non esista già un task sullo stesso argomento. Se esiste → UPDATE. Mai duplicare.
- `session_checkpoints` — Quick saves from session_checkpoint tool
- `action_log` — Automatic audit trail of all MCP write operations
- `system_docs` — Session context, project-state, tech-stack
- `knowledge_articles` — Business rules (59 articles)

### Claude.ai equivalent
For Claude.ai (MCP), the same system exists as middleware in `lib/mcp/reminder.ts` — it injects reminders directly into tool responses after 5/10/15 calls. The `session_checkpoint` MCP tool saves to `session_checkpoints` and resets the counter.

## CRM Update Rule — MANDATORY
Every client-facing action MUST be followed by an IMMEDIATE CRM update in the SAME operation. Never wait to be asked.
Client-facing actions include: sending emails, creating/uploading documents, generating forms, changing statuses, making calls.
What to update:
1. **Account notes** — append a dated log entry (e.g., "2026-03-17: OA + ICA inviati per revisione")
2. **Task** — create or update a task reflecting the current status (e.g., "Waiting" for client response)
3. **Record status** — update relevant record statuses (e.g., offer sent, lease sent, OA viewed)
If you send an email and don't update the CRM, that action is INCOMPLETE. Antonio should NEVER have to remind you.

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
Always communicate in English. Be direct and efficient.

## Multi-Machine Git Safety (iMac + Mac Mini + MacBook)
All three machines share the same repo via GitHub auto-sync.

### CRITICAL RULE #0: `git pull` BEFORE any work
Every session MUST start with `git pull origin main`. This is enforced by the SessionStart hook (`session-git-pull.sh`).
- If pull fails due to uncommitted changes → stash, pull, then decide what to do with stash
- If pull fails due to conflicts → STOP and alert Antonio
- NEVER read code, make decisions, or propose changes based on stale local state
- This rule exists because working on 3 machines simultaneously causes constant desync

### CRITICAL RULE #1: Never use `git add -A` or `git add .`
These commands stage EVERYTHING, including deletion of files that exist on remote but are missing locally.
If your working copy is behind, `git add -A` will DELETE other machines' work.

**Always do:**
```bash
git add path/to/specific-file.ts path/to/other-file.ts
```

**Before committing, always:**
1. `git pull origin main` — get latest
2. `git diff --stat` — review what will be committed
3. `git add <specific files>` — only your changes
4. `npm run build` — verify nothing is broken
5. `git commit` then `git push`

**Never commit files you didn't intentionally modify.** If `git status` shows unexpected deletions or modifications, investigate before committing.

### Protected files — DO NOT TOUCH without explicit request
These files are shared infrastructure. **NEVER modify, simplify, revert, or "clean up" these files** unless Antonio explicitly asks you to:
- `scripts/git-auto-pull.sh` — auto-pull + npm ci detection
- `.husky/pre-push` — build check before push
- `.claude/settings.json` — hooks configuration
- `CLAUDE.md` — project rules
- `middleware.ts` — auth middleware
If `git status` shows these as modified, **leave them alone** — another machine likely updated them intentionally.

### When `git push` fails (non-fast-forward)
Another machine pushed first. This is NORMAL in a multi-machine setup. Follow this sequence:
1. `git pull --rebase origin main` — replay your commits on top of the latest remote
2. If **no conflicts**: `npm run build` → if passes → `git push`
3. If **conflicts exist**: **STOP**. List the conflicted files. Ask Antonio which version to keep.
4. After resolving conflicts: `git rebase --continue` → `npm run build` → `git push`
5. **NEVER run `git push --force`** — branch protection will block it, and it would destroy other machines' work

### Simultaneous work on multiple machines
When Antonio works on all 3 machines at once:
- Each machine works on **different files** to minimize conflicts
- Commit and push frequently (small commits > big commits)
- Auto-pull runs every 5 minutes on each machine
- If two machines edit the **same file**: the second to push will need `git pull --rebase`
- If auto-pull finds uncommitted changes, it **skips** (by design) — no data loss

### Module-Level Initialization
Never use `createClient()` at module level in API routes or lib files — Next.js evaluates these at build time when env vars may not exist. Use:
- `import { supabaseAdmin } from "@/lib/supabase-admin"` (Proxy-based lazy init), or
- A local `getSupabase()` getter function

## Do NOT
- Use Make, Zapier, n8n — all automation via Supabase Edge Functions
- Commit `.env.local` or credentials
- Create README.md or documentation files unless asked
- Push to main without building first (`npm run build`)
- Use `git add -A` or `git add .` — always add specific files
