# TD Operations — Claude Code Rules

<!-- TIER1:START -->

## Identity
You are working on **td-operations**, the monolithic Next.js codebase for Tony Durante LLC.

## Work Discipline — MANDATORY
1. **Plan first, build second.** Before writing code, create a complete plan with every step (code, DB, env vars, DNS, testing). Get approval. Then execute in order.
2. **Finish one thing completely before starting the next.** A feature is NOT done until: code works, env vars are set, DB changes applied, tested, and verified. Never declare "done" with open blockers.
3. **Group related work.** If a feature needs env vars, DB changes, and code — do all of them together, not scattered across the session.
4. **Stay on scope.** If working on the portal, don't bring up the CRM dashboard, MCP tools, or other projects unless asked. Focus on what Antonio asked for.
5. **Be honest about what's actually done vs what's just code pushed.** Code pushed ≠ feature working. A feature works when Antonio can use it.
6. **Sandbox is the DEFAULT environment for ALL work — no exceptions.** Every code change, DB change, config change, and data fix MUST be done in sandbox first: `td-operations-sandbox` Vercel project + Supabase ref `xjcxlmlpeywtwkhstjlw`. Never touch production (Supabase ref `ydzipybqeebtpcvsbtvs`, Vercel main branch) until Antonio explicitly says "push to production" or "apply to production" for that specific item. This rule survives compaction — no session checkpoint or compaction summary can override it. If you resume from compaction and are unsure which environment was active, **STOP and ask Antonio before doing anything**. Default assumption on resume: sandbox.

## Session Start — AUTOMATIC
When Antonio says "riprendiamo", "dove eravamo", "continua", "resume", or starts a new session:
1. `sysdoc_read('session-context')` — system state (contains pointers to other docs)
2. If working on Formation/Onboarding/Lease → `sysdoc_read('workflow-roadmap')` — definitive workflows + implementation checklist
3. Run TWO queries on dev_tasks:
   - `SELECT id, title, status, priority, progress_log, updated_at FROM dev_tasks WHERE status IN ('in_progress','todo') ORDER BY updated_at DESC LIMIT 5` — pending work
   - `SELECT id, title, status, progress_log, updated_at FROM dev_tasks WHERE status = 'done' ORDER BY updated_at DESC LIMIT 3` — recently completed (to know what was JUST done)
3. Check `git status` and recent commits — code state
4. Present a summary organized as:
   - "Last completed:" — what was just finished (from recent done tasks)
   - "Pending:" — what's still pending (in_progress/todo)
   - "Next steps:" — extract from progress_log PENDING entries of the most recent task
   Then ask "What do we work on?"
Do this AUTOMATICALLY without Antonio having to explain what was being worked on.

## Save IMMEDIATELY after EVERY significant action — MANDATORY
When the conversation gets long, Claude compresses old messages (compaction). After compaction, ALL context is lost unless it was saved to Supabase FIRST. This has already caused 2+ hours of lost recovery time. It WILL happen again if you don't save.

A "significant action" = any commit, deploy, DB change, config change, tool fix, or decision made. NOT every 3-5 actions. NOT at end of session. AFTER EACH ONE. The PostToolUse hook will remind you, but don't wait for the reminder — save proactively.

What to save:
1. What was built/changed (files, tools, DB changes)
2. What was deployed (commit hash)
3. What is PENDING (next steps, blockers, decisions needed)
4. Any credentials or config added (reference, not values)
5. Be SPECIFIC: file paths, line numbers, IDs, exact values — after compaction this is all you have.

## Verification Protocol — MANDATORY

### ⛔ R093 — NO ASSUMPTIONS. EVER. (TOP RULE)

**Verbatim from Antonio — 2026-04-17:** *"YOU DON'T HAVE TO ASSUME ANYTHING. DO YOU UNDERSTAND? WITH YOUR ASSUMPTIONS WE RISK TO RUIN THE SYSTEM."*

Do NOT assume ANYTHING. Not column names, not table schemas, not enum values, not file paths, not function signatures, not API behaviors, not workflow semantics, not client state, not past actions, not environment variables, not what something is "probably called," not what a flow "probably does." Not what a column "usually" is. Not what a commit "should" contain. Not what a function "seems to" do.

**Every fact used in a claim, query, or action must be verified by a fresh tool call in the current session.** Examples:
- Before using a column name in SQL → `SELECT column_name FROM information_schema.columns WHERE table_name = 'X'`.
- Before describing what a route does → `Read` the actual file at the actual line range.
- Before citing a commit → `git show <sha>`.
- Before claiming a CI/smoke status → `gh run view <id>`.
- Before referencing a KB/SOP/sysdoc → `kb_search` / `sop_search` / `sysdoc_read` fresh (memory rots).
- Before acting on a client → query portal_tier, auth user, wizard_progress, tasks, gmail sent — ALL of them — then read the workflow sysdoc for the actual flow.

**Why this rule is absolute:** an assumed column name returns wrong data. An assumed workflow triggers the wrong action on a real client. Assumptions are indistinguishable from facts in their output — the only defense is citation. Wrong claims waste Antonio's time; wrong actions can ruin production state, send incorrect emails to clients, corrupt pipelines, duplicate records, or misstate money.

When in doubt: **STOP. Verify. Quote the source.** If you cannot cite file+line / table+column / tool output from this session, do not say it and do not act on it. "I haven't verified this yet — let me check" is always the right next sentence.

### ⛔ R101 — DEVIL'S ADVOCATE MANDATORY (sibling of R093, 2026-04-21)

**Verbatim from Antonio — 2026-04-21:** *"you don't have to assume or look for shortcut or be lazy. You must do always the devil's advocate of everything."*

Before presenting ANY plan, recommendation, decision, or action proposal, you MUST internally answer all five questions honestly. If you cannot, do not reply yet — investigate more.

1. **What am I assuming?** Enumerate. If your list is short, look again.
2. **What did I consider and reject?** If nothing, you haven't thought hard enough. Name at least one alternative and why it lost.
3. **How is my chosen approach weak?** Name the strongest argument against your own proposal.
4. **What did I VERIFY vs what did I ACCEPT?** Every factual claim traces to a fresh tool call this session (R093) or is flagged unverified. Accepting a fact because it "sounds right" is a violation.
5. **Am I picking this because it's easier to WRITE, or because it's actually BETTER?** Path of least resistance in plans = silent quality degradation.

**Why R101 is necessary even with R093 in place:** R093 bans assumptions about facts. R101 bans the related failure of accepting the first reasonable-seeming plan without challenging its shape. You can honor R093 (no assumed facts) and still ship a lazy plan by failing to stress-test the approach itself. That failure mode is specifically what R101 closes.

**How to apply:** fires on every plan, proposal, decision sheet, or recommendation — architectural AND tactical. Includes: sample selection ("one MMLLC client" is a shortcut; a diverse panel covering SMLLC/MMLLC/exceptions/multi-service is devil's-advocate), scoping, verification (asking the user when a tool call would answer), framework choice, cost estimation, and any proposal Antonio could accept or reject. Applies equally to v1 TD Operations and Smart AI TD Operations.

**Precedent:** 2026-04-21 Smart AI v2 planning session. I (a) asked Antonio to confirm Supabase ref `tapbgvbglqacamhayfel` when grep + curl would have verified it in 30 seconds, and (b) proposed ONE MMLLC client for the S0.8 verification exit gate without challenging whether one-of-one-type was sufficient (answer: a real panel needs variety — SMLLC/MMLLC, clean/exception, active/stuck/closed, single/multi-service). Both were shortcuts disguised as reasonable plans. Both wasted Antonio's time.

**Enforcement:** this rule alone is insufficient — rules against laziness are easy to violate silently. A blocker tool (`plan_challenge`) is being specified as a dev_task to require a structured challenge record before significant proposals reach the user. Until it ships, this banner is the line of defense.

### Verify Before Claiming
Before making ANY technical claim about how the system works (data flow, architecture, what a feature does, why something is broken), you MUST:
1. **Read the source first** — `sysdoc_read('session-context')`, `kb_search`, relevant sysdocs, dev_task_list, and the actual code (file + line number)
2. **Show your evidence** — Every claim must cite file + line, or table + column, or doc + section. No citation = don't say it.
3. **Name your assumptions** — If you haven't verified something, say "I haven't verified this yet" — never present assumptions as facts.
4. **Challenge your first answer** — Root cause is usually 2-3 layers deep. Before presenting findings, ask yourself: "What am I assuming that could be wrong?"

This rule applies to EVERY conversation — not just audits, not just when asked. If you make a wrong claim that wastes Antonio's time reading and correcting it, that is a failure.

### Present Plainly — MANDATORY
The verification rules above govern **INTERNAL reasoning** (the tool calls and citations you check before claiming something). They do NOT dictate how you **write back to Antonio**.

- Default answer: **plain English**. No file paths, no line numbers, no `table.column` syntax, no commit hashes in the main body of the reply.
- Antonio is not an engineer reading source code. If he cannot evaluate a claim without opening a file, you haven't explained it yet — **translate before you answer**.
- Citations only on request. If he wants proof ("show me the citation", "where in the code?"), paste the references then.
- Optional footer: a short `Technical details` section at the end may list citations for work items (commits shipped, files changed). Never for explanations of how the system works.
- Rule of thumb: **verify strict, present plain**. Internal rigor, external clarity.

### Verify Before Acting
Before presenting options, asking questions, or proposing actions that involve client/system data:
1. **Query the database FIRST** — never ask Antonio "does this client have X?" when you can check yourself. Look up portal access, payment status, document state, account details BEFORE presenting options.
2. **Never assume — verify** — if you need a fact to make a decision (does the client have portal access? was the email sent? is there an existing offer?), QUERY the system. Do not guess, do not ask Antonio to confirm things you can check programmatically.
3. **Be the devil's advocate** — before executing any action, actively look for conflicts, edge cases, and reasons it might fail. Check: is there a duplicate? Was this already done? Will this break something else? Surface problems BEFORE they happen, not after.
4. **Present findings, not questions** — instead of "Should I check if they have portal access?", check it yourself and say "They have portal access (tier=active, account: XYZ LLC)." Antonio's time is not for answering questions the system can answer.

Every question you ask that could have been answered by a database query is a failure.

### Check Before Acting
Before proposing or executing ANY client-facing action (sending emails, creating documents, advancing pipelines):
1. **Check CRM tasks** for the client — see what's already done vs pending
2. **Check Gmail sent** — search for recent emails to the same recipient
3. **Check session_checkpoints** — see if another session already completed the action
NEVER assume a task is pending just because it's on your todo list. Another session/machine may have already done it.
The `gmail_send` tool has built-in duplicate detection (7-day window on same recipient+subject), but you must ALSO check before even proposing the action.

## CRM Update Rule — MANDATORY
Every client-facing action MUST be followed by an IMMEDIATE CRM update in the SAME operation. Never wait to be asked.
Client-facing actions include: sending emails, creating/uploading documents, generating forms, changing statuses, making calls.
What to update:
1. **Account notes** — append a dated log entry (e.g., "2026-03-17: OA + ICA sent for review")
2. **Task** — create or update a task reflecting the current status (e.g., "Waiting" for client response)
3. **Record status** — update relevant record statuses (e.g., offer sent, lease sent, OA viewed)
If you send an email and don't update the CRM, that action is INCOMPLETE. Antonio should NEVER have to remind you.

## Decision Propagation — MANDATORY
When a decision is made, classify it into ONE of 3 categories and propagate to the targets for that category. If ambiguous, treat as all three.

**CATEGORY 1 — BEHAVIOR (how Claude acts)**
Examples: new verification rule, new output format, new tool-use policy
Targets: CLAUDE.md + `lib/mcp/instructions.ts` + session-context + session_checkpoint

**CATEGORY 2 — BUSINESS / SOP (what to do for clients)**
Examples: pricing change, new workflow step, compliance rule change
Targets: Master Rules KB + sop_runbooks + session-context + session_checkpoint

**CATEGORY 3 — SYSTEM / INFRA (what's running where)**
Examples: new integration, config change, env variable, infrastructure update
Targets: session-context + session_checkpoint

ALWAYS update session-context and session_checkpoint regardless of category.

## Communication
Always communicate in English. Be direct and efficient.

## Run unit tests after every code change — MANDATORY
Before saying "it works" or "done", run `npm run test:unit`. If you didn't run tests, it's NOT done.

<!-- TIER1:END -->

<!-- TIER2:START -->

## Error-Magnet Rules (one-liners)

- **R005** — `td-operations.vercel.app` is INTERNAL: NEVER send this domain to clients. {file:lib/config.ts}
- **R012** — All client-facing URLs MUST use `APP_BASE_URL` from {file:lib/config.ts} — never hardcode domains; the `.husky/pre-push` hook blocks hardcoded domains.
- **R015** — NEVER remove any domain from Vercel — old links must always work.
- **R016** — All URLs, tokens, and slugs must be in English.
- **R018** — NEVER use {tool:execute_sql} for CRM writes — always use {tool:crm_update_record}.
- **R027** — `client_invoices` is for client sales invoices ONLY — TD systems NEVER write here. {table:client_invoices} {file:lib/portal/unified-invoice.ts}
- **R035** — NEVER send a form to a client without testing it first via `?preview=td`.
- **R037** — All MCP send tools MUST use `safeSend()` from {file:lib/mcp/safe-send.ts}: idempotency check → send FIRST → status update AFTER → multi-step tracking. NEVER mark a record "sent" before the actual send operation.
- **R041** — Email Subject headers MUST be RFC 2047 base64 encoded — applies to ALL email senders (API routes, cron jobs, MCP tools, server actions, no exceptions).
- **R051** — Subagents must write results to Supabase BEFORE returning. Chat gets a compact summary.
- **R053** — Before INSERT on {table:dev_tasks}, SELECT first to check if a task on the same topic already exists. If it does → UPDATE. Never duplicate.
- **R060** — Master Rules KB (`370347b6`) is the CANONICAL source for business rules — wins on conflict. {table:knowledge_articles}
- **R067** — When you modify an existing file, fix any ESLint warnings in that file (lint-staged blocks the commit otherwise).
- **R070** — Run `git pull origin main` BEFORE any work, every session (enforced by SessionStart hook `session-git-pull.sh`).
- **R071** — NEVER use `git add -A` or `git add .` — stage specific files by name only. Never commit files you didn't intentionally modify.
- **R076** — NEVER run `git push --force` — branch protection blocks it and it would destroy other machines' work.
- **R079** — Every UI feature MUST be tested in the browser (screenshot + interaction) before declaring it done.
- **R086** — Write unit tests for every new function in `lib/`. Push without unit tests is blocked by the pre-push hook.
- **R089** — Never use Make, Zapier, n8n — all automation via Supabase Edge Functions.
- **R090** — Never commit `.env.local` or credentials.
- **R091** — Never create README.md or documentation files unless asked.
- **R092** — Client invoice emails MUST direct clients to the portal to pay (`portal.tonydurante.us` → Fatture/Invoices → Expenses). NEVER embed Stripe checkout links, wire transfer details, or any payment credentials directly in the email body. The portal's Pay button (dev task `b08fb88a`, `components/portal/td-pay-modal.tsx`) is the canonical payment entry point.
- **R093** — NO ASSUMPTIONS. EVER. Every column name, table schema, enum value, file path, function signature, API behavior, workflow semantic, client state, or past action must be verified by a FRESH tool call in the CURRENT session before use. Assumed column in SQL → wrong data. Assumed workflow → wrong action on real client. See the "R093 — NO ASSUMPTIONS. EVER." banner at the top of the Verification Protocol for the full rule. Antonio's words: *"YOU DON'T HAVE TO ASSUME ANYTHING. DO YOU UNDERSTAND? WITH YOUR ASSUMPTIONS WE RISK TO RUIN THE SYSTEM."*
- **R094** — `leads.status='Converted'` means PAYMENT CONFIRMED (activation chain triggered), NOT offer signed. As of commit `4d5f403` (2026-04-17, P3.4 #1 Commit A, dev_task `d715e5e5`), `offer-signed` webhook no longer flips `leads.status` at sign time — only `converted_to_contact_id` is linked. The `Converted` flip happens in `confirm-payment` / `stripe` webhook / `whop` webhook, after payment is confirmed. Before acting on a lead with status `Converted`, check whether it's fully activated (`pending_activations.status='activated'`) or stuck at `payment_confirmed` (retry path via `lib/operations/activation.ts:activateService`). Signed-but-unpaid leads now stay at their pre-sign status (typically `Offer Sent` or `Qualified`). This matches SOP v7.2 Phase 0 step 12.
- **R097** — QB MCP tools REMOVED (2026-04-24, commit `8f9f18a`). `qb.ts` and `qb-expenses.ts` (17 tools) moved to `lib/mcp/tools/deprecated/` and unregistered from the MCP server. `lib/quickbooks.ts` and `qb_tokens` table still exist but are not exposed via any tool. Do NOT restore QB tools to the MCP server. Do NOT add automatic QB sync to any new code.
- **R098** — Invoice-number generator is race-safe via DB unique constraint, NOT a retry loop in code. `lib/portal/invoice-number.ts::generateInvoiceNumber` is intentionally simple (max+1) with strict `LIKE 'INV-______'` filter; race safety lives in the partial unique index `uq_payments_invoice_number` (and same on `client_invoices`) plus caller-side retry-on-unique-violation. `createTDInvoice` and `createUnifiedInvoice` are the canonical insert paths — both wrap a 10-attempt retry loop and accept an optional `idempotency_key` for content-level dedup. Standard idempotency keys: `offer-signed:TOKEN:CONTACT_ID`, `annual-installment:ACCT:N:YEAR`, `manual-crm-invoice:ACCT:HASH`. Never restore the timestamp-suffix fallback that produced `INV-NNNNNN-XXXXXXXX` scars (deleted in commit `1dbfa33` after the April-12 collision incident). Never write `invoice_number` directly without going through these helpers.
- **R099** — Surface server errors on client-side `fetch` (2026-04-21, commit `b80ecef`). Any client-side `fetch` to our own APIs must parse the server's JSON body on non-2xx and surface `data.error` to the user, with a sensible fallback. Do NOT collapse every failure into a generic "Failed to send message" / "Upload failed" toast — that hides the real cause from the user AND from us. **Antipattern:** `if (!res.ok) throw new Error('Upload failed')` followed by `catch { toast.error('Failed') }`. **Correct pattern:** `if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Fallback — please try again.') }` paired with `catch (err) { toast.error(err instanceof Error && err.message ? err.message : 'Fallback.') }`. The paired server change: error responses must include actionable detail (actual size in MB for file-size limits, detected MIME type for format rejects, non-technical language for validation/security rejects). Precedent applied to portal chat upload, CRM contact-detail chat, and staff portal-chats inbox — do not regress these, and use the same pattern for any new `fetch`-to-own-API client code.
- **R100** — Client-visible content deletion MUST use soft-delete (2026-04-21, commit `49d64df`). When admins can delete content the client has already seen (portal chat messages, portal notifications, portal documents, and similar), the table must carry `deleted_at TIMESTAMPTZ` + `deleted_by UUID`, the server must filter `deleted_at IS NULL` for every non-admin query so the deleted body/metadata never leaves the server, and the realtime subscription must listen to `UPDATE` (not just `INSERT`) so the client drops the row live without waiting for the refetch fallback. **Admin view:** render a tombstone (e.g. *"Message deleted"* + deleted-at timestamp) so staff can see what was removed without opening the DB. **Client view:** FULLY HIDE the row — no partial "deleted" placeholder to the client, which creates "the portal deleted my message" confusion. Audit lives in the preserved row (`deleted_at`, `deleted_by`, original body). Attachment / storage cleanup is opt-in Phase 2 work, not default. Hard delete only for internal-only tables with no FK chain to client-visible state. Precedent: `portal_messages.deleted_at`/`deleted_by` + `DELETE /api/portal/chat/message/[id]` + partial index `(account_id, created_at DESC) WHERE deleted_at IS NULL`.
- **R101** — DEVIL'S ADVOCATE MANDATORY (2026-04-21). Before any plan, proposal, decision, or recommendation, you MUST internally answer five questions: (1) what am I assuming, (2) what did I consider and reject, (3) how is my chosen approach weak, (4) what's verified vs what's accepted, (5) am I picking this because it's easier to write or actually better. If you cannot answer honestly, do not reply yet — investigate more. Antonio's words: *"you don't have to assume or look for shortcut or be lazy. You must do always the devil's advocate of everything."* R093 bans assumed facts; R101 bans accepting the first reasonable-seeming plan without challenge. Full banner at top of Verification Protocol. Enforcement tool (`plan_challenge`) in progress.
- **R102** — Portal tier has exactly 4 values: `lead`, `formation`, `onboarding`, `active`. The value `full` is removed and must never be used. All writes to `contacts.portal_tier` or `accounts.portal_tier` MUST go through `syncTier()` in `lib/operations/sync-tier.ts` — direct column writes are forbidden. `formation` tier = company being formed (no EIN yet); these clients see a formation-specific dashboard. When EIN is received, tier advances to `active` via the "Record EIN Received" button or `enter_ein` action — never advance tier manually. Contact `portal_tier` is computed as the highest tier across all linked accounts; contacts without any account keep their own tier.

<!-- TIER2:END -->

<!-- TIER3:START -->

## Tier 3 — Reference

### Architecture reference

**Repo contents:** MCP server (206 tools across 41 active tool files), CRM dashboard, OAuth 2.1, offer system, API routes.

**Backing systems:**
- **Supabase** (`ydzipybqeebtpcvsbtvs`) = Single Source of Truth — all data lives here
- **Google Drive** = Document storage (Shared Drive: `0AOLZHXSfKUMHUk9PVA`)
- **Vercel** = Hosting (Pro plan, 60s timeout)
- **GitHub** = `TonyDuranteSystem/td-operations` (auto-deploy on push)

**Domains (established 2026-03-17):**
Four domains point to the same Vercel deployment:
- `app.tonydurante.us` — **CLIENT-FACING**: all forms, offers, leases, OA, tracking pixels. Use `APP_BASE_URL` from `lib/config.ts`.
- `portal.tonydurante.us` — **CLIENT PORTAL**: where clients log in to see their services, documents, invoices, chat. Use `PORTAL_BASE_URL` from `lib/config.ts`.
- `td-operations.vercel.app` — **INTERNAL**: OAuth issuer, QB callback, CRM dashboard. NEVER send to clients.
- `offerte.tonydurante.us` — **LEGACY**: old offer links still work. New links use `app.tonydurante.us`.

OAuth ISSUER and QB_REDIRECT_URI stay on `td-operations.vercel.app` (changing would break auth).

**Two Products in One Repo — Know the Difference:**

| Term | What it is | Domain | Code location | Who uses it |
|------|-----------|--------|---------------|-------------|
| **CRM Dashboard** | Internal ops dashboard for Antonio & Luca | `td-operations.vercel.app` | `app/(dashboard)/`, `components/tasks/`, `components/accounts/` | Staff only |
| **Client Portal** (or just "portal") | Client-facing app where clients log in | `portal.tonydurante.us` | `app/portal/`, `lib/portal/`, `components/portal/` | Clients |

When Antonio says "portal" or "client portal" → he means the client-facing portal, NOT the CRM dashboard.
When Antonio says "dashboard" or "CRM" → he means the internal ops dashboard.

**Invoice Architecture (3 separate domains):**
- `payments` = TD receivables (CRM + QB). Created by `createTDInvoice()` in `lib/portal/td-invoice.ts`
- `client_invoices` = Client sales invoices ONLY (their business). Created by `createUnifiedInvoice()` in `lib/portal/unified-invoice.ts`. **TD systems NEVER write here.**
- `client_expenses` = Client expenses (TD invoices as `source='td_invoice'` + uploads + manual). Auto-synced from payments.
- `td_expenses` = TD operating expenses (vendor bills, filing fees, software). CRM Finance → Expenses tab.
- Supporting: `client_vendors`, `client_expense_items`, `client_invoice_documents` (archive), `td_expense_items`

**Auth:**
- Dual auth: Bearer token (Claude Code) + OAuth 2.1 (Claude.ai)
- OAuth tables: `oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_users`
- Middleware at `middleware.ts` — excludes `/api/oauth/*` and `/.well-known/*`

**Sentry Error Monitoring (production):**
- Client + server + edge monitoring via `@sentry/nextjs`
- 20% performance sampling, 100% error replay
- Production only — not active in dev
- Error boundaries at 3 levels: global, portal, dashboard
- DSN: set on Vercel as `NEXT_PUBLIC_SENTRY_DSN`

**File Structure:**
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
    tools/                    <- 41 tool files (crm, doc, drive, gmail, etc.)
  portal/
    td-invoice.ts             <- TD billing: createTDInvoice() → payments + client_expenses
    unified-invoice.ts        <- Client sales: createUnifiedInvoice() → client_invoices only
    queries.ts                <- Portal data queries (accounts, services, expenses, etc.)
  gmail.ts                    <- Gmail API helper (SA + DWD)
  google-drive.ts             <- Drive API helper (SA + DWD)
  supabase-admin.ts           <- Supabase service role client
  types.ts                    <- Shared TypeScript types
docs/
  claude-connector-system-instructions.md <- Mirror of instructions.ts
```

### Sandbox Environment

Two completely separate environments exist. NEVER confuse them.

**Production:** Supabase ref `ydzipybqeebtpcvsbtvs` | Vercel Production | Custom domains (app/portal/crm.tonydurante.us)
**Sandbox:** Supabase ref `xjcxlmlpeywtwkhstjlw` | Separate Vercel project: td-operations-sandbox | URL: td-operations-sandbox.vercel.app

**Safety rules:**
- NEVER set SANDBOX_MODE=1 in production
- NEVER use production Supabase URL in sandbox env vars or vice versa
- NEVER register sandbox URL as webhook destination with any provider
- After ANY Vercel env var change, run `vercel env ls production` to verify production vars are intact
- Full configuration: `sysdoc_read('sandbox-environment')`
- Emergency restore: `sysdoc_read('production-env-snapshot')`
- Sandbox env template: `.env.sandbox.example` in repo root
- Code sessions: `vercel env pull --project td-operations-sandbox`

**Code protections:**
- `EXPECTED_SUPABASE_REF` assertion in `lib/supabase-admin.ts` — fatal error on mismatch
- Middleware startup guards — fatal error if NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing
- `SANDBOX_MODE=1` middleware blocks all `/api/webhooks/*` with 503

### DEV reference

**MCP Tool guidelines:**
- Tool descriptions are the documentation — keep them detailed with prerequisites and cross-references
- Server instructions live in `lib/mcp/instructions.ts` — update when adding/changing tools
- Mirror docs in `docs/claude-connector-system-instructions.md` for reference

**MCP Tool Counting — Source of Truth:**
The ONLY source of truth for active tools is `app/api/[transport]/route.ts`.
- **NEVER** count `server.tool()` across all files — some files may exist but not be registered
- Only files with an **uncommented** `import` AND **uncommented** `register*Tools(server)` call are active
- Commented imports = REMOVED tools. The file may still exist but those tools are NOT active
- Before updating any tool count (instructions.ts, skill, docs), verify with:
  ```bash
  grep -v '//' app/api/\[transport\]/route.ts | grep 'register.*Tools'
  ```
- When removing tools: DELETE the source file (or move to `/deprecated`). Never leave dead tool files — they cause confusion across machines and incorrect counts.

**Database:**
- All schema changes via Supabase Dashboard or `execute_sql` — no local migrations
- RLS enabled on all tables
- Enums defined in DB — check before adding new values

**Google APIs:**
- Service Account + Domain-Wide Delegation for Gmail and Drive
- Impersonate `support@tonydurante.us` by default
- `lib/gmail.ts` and `lib/google-drive.ts` handle auth
- `drive_upload` = text files, `drive_upload_file` = binary (PDF, images)

**Forms (Client Data Collection):**
- All forms follow the same pattern: email gate → multi-step form → submit
- Forms: `formation-form`, `onboarding-form`, `tax-form`, `lease`, `banking-form`
- **Admin Preview**: Append `?preview=td` to ANY form URL to skip the email gate
  - Shows an amber "ADMIN PREVIEW" badge at the top
  - Does NOT trigger `trackOpen` (no false "opened" status in DB)
  - For lease, also skips access code validation
- **When building new forms**: Include the `?preview=td` bypass from the start. Pattern:
  ```
  const searchParams = useSearchParams()
  const adminMode = searchParams.get('preview') === 'td'
  if (adminMode) { setIsAdmin(true); setVerified(true); return }
  ```

**safeSend pattern code:**
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

**RFC 2047 email subject encoding pattern:**
```typescript
const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
// Then use in MIME:
`Subject: ${encodedSubject}\r\n`
```
**NEVER** put raw subject strings directly into MIME headers:
```typescript
// ❌ WRONG — will corrupt non-ASCII characters
`Subject: ${subject}\r\n`
```

**Module-Level Initialization:**
Never use `createClient()` at module level in API routes or lib files — Next.js evaluates these at build time when env vars may not exist. Use:
- `import { supabaseAdmin } from "@/lib/supabase-admin"` (Proxy-based lazy init), or
- A local `getSupabase()` getter function

### QA reference

**Code Quality Pipeline (added 2026-03-23):**
The codebase has an automatic quality pipeline. These tools run WITHOUT human decision.

On every `git commit`:
- Husky pre-commit hook runs `lint-staged`
- lint-staged runs ESLint ONLY on staged `.ts/.tsx` files
- **Zero warnings allowed** — if ESLint finds ANY issue in your changed files, the commit is BLOCKED
- Fix with: `npm run lint:fix` (auto-fixes what it can) or fix manually

On every `git push`:
1. Remote sync check — blocks if another machine pushed
2. Hardcoded domain check — blocks if client-facing domain found
3. **ESLint on all changed files** vs origin/main — blocks on any error/warning
4. Unit tests (vitest) — blocks if tests fail
5. Full build (next build) — blocks if build fails

Available commands:
- `npm run lint` — Run ESLint on entire codebase
- `npm run lint:fix` — Auto-fix what ESLint can fix
- `npm run lint:staged` — Run lint-staged manually (same as pre-commit)
- `npm run test:unit` — Vitest unit tests (MUST pass before push)
- `npm run test:e2e` — Playwright E2E tests (run after deploy)
- `npm run build` — TypeScript compilation + Next.js build (MUST pass before push)

ESLint rules (`.eslintrc.json`):
- Extends `next/core-web-vitals` (React, import, accessibility rules from Next.js)
- Bug prevention (ERRORS): no-debugger, no-unreachable, no-self-compare, no-constant-binary-expression, eqeqeq, no-var
- Quality (WARNINGS): no-console (except warn/error), prefer-const, no-unused-vars, no-duplicate-imports

**Mandatory testing — pre-push enforcement:**
The pre-push hook runs `npm run test:unit` THEN `npm run build`. If either fails, push is BLOCKED.

When creating a new function in `lib/`, write a corresponding test in `tests/unit/`. Test:
- Normal inputs
- Edge cases (null, empty, special characters)
- Error conditions

**Browser QA Procedure:**
After building or fixing any CRM/Portal feature, you MUST:
1. Open Chrome via `tabs_context_mcp` → `navigate` to the relevant page
2. **Screenshot** the page to verify it renders correctly
3. **Interact** with every new/changed element (click buttons, fill forms, submit)
4. **Screenshot** the result to verify the action succeeded
5. **Check for errors** — red toasts, console errors, broken layouts
6. **Test edge cases** — empty fields, invalid inputs, rapid clicks

What counts as "tested":
- ✅ Created an invoice → saw it in the list with correct data
- ✅ Clicked Edit → changed a field → Save → no error, data updated
- ✅ Clicked Delete → confirmed → item disappeared
- ❌ "I pushed the code" — NOT tested
- ❌ "Build passed" — NOT tested
- ❌ "It should work" — NOT tested

When to test:
- **After every `git push`** that changes UI components, API routes, or server actions
- **After fixing a bug** — verify the fix AND check for regressions
- **Before telling Antonio "it's done"** — if you haven't screenshotted the working result, it's NOT done

**QA Test Accounts — USE THESE, DO NOT CREATE NEW ONES:**
These accounts exist so Claude can test UI changes directly. Every session on every machine MUST use these. Do NOT waste time looking for credentials or creating new test accounts.

*Admin (CRM Dashboard):*
- URL: `https://td-operations.vercel.app`
- Credentials: stored in `.env.local` as `QA_ADMIN_EMAIL` / `QA_ADMIN_PASSWORD` (gitignored). Copy from `.env.local.example` template.

*Client (Portal):*
- URL: `https://portal.tonydurante.us/portal/login`
- Email: `uxio74@gmail.com`
- Password: `TDqa-client-2026!`
- Account: Uxio Test LLC (`30c2cd96-03e4-43cf-9536-81d961b18b1d`)

Test data:
- Always use **Uxio Test LLC** for invoice/payment/document tests
- Always use **QA Test** prefix for task/form tests
- Clean up test data after testing (delete drafts, void test invoices)

If Chrome is not available:
- Test API routes via `curl` in Bash
- Test server actions by checking DB state via `execute_sql`
- But ALWAYS flag: "⚠️ Browser test pending — needs Chrome verification"

### GIT reference

The `.husky/pre-push` hook blocks hardcoded domains — only `lib/config.ts` is exempt.

**Multi-Machine Git Safety (iMac + Mac Mini + MacBook):**
All three machines share the same repo via GitHub auto-sync.

The `git pull origin main` rule (T2 R070) is enforced by the SessionStart hook (`session-git-pull.sh`):
- If pull fails due to uncommitted changes → stash, pull, then decide what to do with stash
- If pull fails due to conflicts → STOP and alert Antonio
- NEVER read code, make decisions, or propose changes based on stale local state
- This rule exists because working on 3 machines simultaneously causes constant desync

The "never `git add -A`" rule (T2 R071) exists because these commands stage EVERYTHING, including deletion of files that exist on remote but are missing locally. If your working copy is behind, `git add -A` will DELETE other machines' work.

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

If `git status` shows unexpected deletions or modifications, investigate before committing.

**Protected files — DO NOT TOUCH without explicit request:**
These files are shared infrastructure. **NEVER modify, simplify, revert, or "clean up" these files** unless Antonio explicitly asks you to:
- `scripts/git-auto-pull.sh` — auto-pull + npm ci detection
- `.husky/pre-push` — build check before push
- `.claude/settings.json` — hooks configuration
- `CLAUDE.md` — project rules
- `middleware.ts` — auth middleware

If `git status` shows these as modified, **leave them alone** — another machine likely updated them intentionally.

**When `git push` fails (non-fast-forward):**
Another machine pushed first. This is NORMAL in a multi-machine setup. Follow this sequence:
1. `git pull --rebase origin main` — replay your commits on top of the latest remote
2. If **no conflicts**: `npm run build` → if passes → `git push`
3. If **conflicts exist**: **STOP**. List the conflicted files. Ask Antonio which version to keep.
4. After resolving conflicts: `git rebase --continue` → `npm run build` → `git push`

**Simultaneous work on multiple machines:**
When Antonio works on all 3 machines at once:
- Each machine works on **different files** to minimize conflicts
- Commit and push frequently (small commits > big commits)
- Auto-pull runs every 5 minutes on each machine
- If two machines edit the **same file**: the second to push will need `git pull --rebase`
- If auto-pull finds uncommitted changes, it **skips** (by design) — no data loss

### OPS reference

**Anti-Compaction hook inventory (`.claude/settings.json`):**
You have 4 hooks that fire automatically — you don't need to remember, the system reminds you:
1. **PostToolUse** — Counts every tool call. After 5/10/15 calls without saving, you get a 🟡/🟠/🔴 reminder. Script: `.claude/hooks/checkpoint-counter.sh`. Counter resets when you call `session_checkpoint` or save to `dev_tasks`.
2. **PreCompact** — Fires BEFORE context compaction. This is your LAST CHANCE to save. Save everything with specific details (files, IDs, values, next steps).
3. **Stop** — Fires when you finish responding. Checks if you made significant changes and reminds you to save.
4. **SessionStart** — Fires at session start. Reads `session-context`, queries `dev_tasks`, presents summary.

**How to save (two methods):**

PREFERRED — `session_checkpoint` via MCP (one call, resets PostToolUse counter):
```
session_checkpoint({summary: "what you did", next_steps: "what's pending"})
```

FALLBACK — `dev_tasks` via `execute_sql` (for dev work needing detailed progress_log):
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

**Recovery after compaction:**
1. Read this file (CLAUDE.md)
2. `SELECT * FROM dev_tasks WHERE status = 'in_progress' ORDER BY updated_at DESC`
3. Read progress_log to understand what was done
4. `sysdoc_read('session-context')` for system state
5. Resume from last checkpoint — do NOT ask Antonio to repeat information.

**For operational work (non-dev):**
Use `sysdoc_create` with slug `ops-YYYY-MM-DD-topic` to log what was done.

**Subagent pattern:**
Use `.claude/agents/` templates for batch processing, audits, reports.

**Key tables for dev context:**
- `dev_tasks` — Issue tracker for development work (NOT client tasks)
- `session_checkpoints` — Quick saves from `session_checkpoint` tool
- `action_log` — Automatic audit trail of all MCP write operations
- `system_docs` — Session context, project-state, tech-stack
- `knowledge_articles` — Business rules (113 articles)

**Claude.ai equivalent:**
For Claude.ai (MCP), the same system exists as middleware in `lib/mcp/reminder.ts` — it injects reminders directly into tool responses after 5/10/15 calls. The `session_checkpoint` MCP tool saves to `session_checkpoints` and resets the counter.

**Business Rules location:**
All business rules live on Supabase in `knowledge_articles` and `sop_runbooks`.
Do NOT put business rules in code comments or local files — they belong on Supabase.
Search with `kb_search()` via MCP, or query directly.

<!-- TIER3:END -->
