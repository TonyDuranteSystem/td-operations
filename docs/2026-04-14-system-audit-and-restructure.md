# TD Operations — System Audit and Restructure Plan

**Date**: 2026-04-14
**Scope**: Complete system audit + architectural analysis + restructure plan
**Status**: Analysis complete. Awaiting approval for execution.
**Context**: Result of 18 parallel investigation agents, direct code reading of critical files, and 4 rounds of devil's advocate self-challenge.

---

## 0. Executive Summary

The system has **30+ data-corrupting bugs** caused by **5 structural architectural failures**. The bugs are symptoms. The disease is that the system has grown organically across multiple machines and sessions without ever being refactored, resulting in:

- **Zero TypeScript type safety** on Supabase queries (`supabase-admin.ts:22` uses `as any`)
- **Two parallel "worlds"** for service delivery writes — one good central function (`lib/service-delivery.ts`), and 10 bypass files that predate it
- **Zero database enforcement** on stage values — verified via `information_schema.columns` (stage is `text` nullable no default), `pg_constraint` (0 CHECK constraints on stage), `information_schema.triggers` (only `update_updated_at_column` trigger, no validation triggers)
- **Zero tests** on the 8 most critical files (3,368 lines of business logic with no test coverage)
- **No single source of truth** — schema definitions exist in PostgreSQL, `lib/constants.ts`, `pipeline_stages` table, and hardcoded strings in 100+ files, all drifted

The restructure plan reverses the order of operations: **instead of fixing bugs one at a time, we fix the architecture so the bugs become impossible, then we fix the remaining bugs.**

---

## 1. How This Was Done (Methodology)

### Phase 1: Broad audit (10 agents)
Launched in parallel covering all 6 sections of the `audit-method-invariant-checklist` sysdoc:
- **Section A** — Schema integrity (code column refs vs actual DB)
- **Section B** — Data integrity (11 invariant queries on live data)
- **Section C** — Code path integrity (8 critical routes × 8 criteria)
- **Sections D+E+F** — Portal visibility, external integrations, write paths
- **Cross-session handoff** — session_checkpoints and dev_tasks infrastructure
- **Portal access chain** — 7 gates from middleware to dashboard
- **Wizard visibility** — why some clients don't see the wizard
- **Document signing pipeline** — why some clients see empty signing page
- **Enum inconsistencies** — DB ENUM vs CHECK vs constants.ts
- **Bank feed pipeline** — why transactions aren't syncing

### Phase 2: Deep architectural agents (4 agents)
- **SD write path architecture** — why 10 files bypass the central function
- **DB-level protections** — what the database enforces vs what it doesn't
- **Test coverage landscape** — inventory of all 22 unit test files + 14 E2E
- **Lifecycle state machine** — designed vs actual client lifecycle

### Phase 3: Verification explores (2 agents + direct reads)
- **Error propagation** — partial (agent output not fully extractable)
- **Supabase type safety** — confirmed `as any` cast, no `database.types.ts` exists
- **Direct reads** — `lib/service-delivery.ts` (534 lines), `lib/constants.ts` (261 lines), `lib/supabase-admin.ts` (24 lines), `app/api/[transport]/route.ts` (218 lines), `sentry.server.config.ts` (12 lines)

### Verification rule
Every claim in this document cites file+line or query+result. Where I couldn't verify something, it's listed in Section 3 (Transparency Test Results).

---

## 2. What Was Tested

Complete list of investigations run, cross-referenced to the findings they produced:

| # | Agent | Scope | Key output |
|---|-------|-------|-----------|
| 1 | Schema Integrity (A) | Column refs in code vs DB schema | 10 violations, 25+ `current_stage` references |
| 2 | Data Integrity (B) | 11 invariant queries on live data | 19 client-impacting violations |
| 3 | Code Path Integrity (C) | 8 routes × 8 criteria | 43 violations across 8 files |
| 4 | Portal+Integrations+Writes (D+E+F) | Portal filter validity, QB token, write path inventory | 10 violations, `getPortalActiveServices` returns empty |
| 5 | Cross-Session Handoff | Checkpoint + dev_task infrastructure | 9 gaps including hardcoded repo paths in hooks |
| 6 | Portal Access Chain | 7 gates from auth to dashboard | 97 contacts with no auth user, 56 desyncs |
| 7 | Wizard Visibility | Tier + data gate analysis | 5 independent failure points for wizard display |
| 8 | Document Signing Pipeline | 6 signing tables + 6 page routes | 7 failure points, 35 Active accounts with zero documents |
| 9 | Enum Inconsistencies | DB ENUM vs CHECK vs constants.ts | 11 enum mismatches including runtime-rejecting values |
| 10 | Bank Feed Pipeline | 6 sync sources + cron registration | Stripe cron missing from vercel.json, Plaid module-level init |
| 11 | SD Write Path Architecture | Why 10 files bypass central function | Temporal gap: central function extracted 3 weeks after bypass files |
| 12 | DB-Level Protections | Triggers, constraints, policies, FKs | `service_deliveries.stage` has ZERO DB enforcement |
| 13 | Test Coverage Landscape | Inventory of all unit + E2E tests | 0/8 critical files have tests (3,368 untested lines) |
| 14 | Lifecycle State Machine | Designed vs actual transitions | 5 parallel tracks, 56 cancelled accounts with active portal tiers |
| 15 | Error Propagation (explore) | How errors propagate in routes | Per-file, no central handler |
| 16 | Supabase Type Safety (explore) | Whether TypeScript catches wrong columns | Confirmed: client typed as `any` |
| 17 | Direct read: `service-delivery.ts` | Central function implementation | Well-designed but only handles ADVANCE, not CREATE |
| 18 | Direct read: `constants.ts` | TypeScript enum definitions | 8+ drifts from DB, `current_stage` not tracked |

---

## 3. Transparency Test Results

In the first draft of this analysis I made several claims I had not yet verified. Here are the results of going back and checking them.

| # | Claim | Verification | Result |
|---|-------|-------------|--------|
| 1 | "206 MCP tools across 41 files" | Grep `server\.tool\(` in `lib/mcp/tools/` returned 206 matches across 41 files. Spot-checked `calendly.ts`: 3 matches at lines 113, 196, 284 — each a distinct tool registration. | **VERIFIED: 206 `server.tool(` occurrences = 206 distinct tool registrations (one per line, not multiple per line).** |
| 2 | "Sentry catches exceptions, not silent failures" | Read `sentry.server.config.ts` (12 lines) | **VERIFIED: only `Sentry.init()` with DSN + sample rate, no custom handling. Silent failures invisible.** |
| 3 | "Form-completed routes have sparse error checking" | Re-verified with precise grep `if\s*\(\s*\w*[Ee]rr` | **CORRECTED: `itin-form-completed` (415 lines) has 1 Supabase error check (line 41: `subErr`); `formation-form-completed` (497 lines) has 1 Supabase error check (line 41: `subErr`). Initial "5" count for formation was a misread — those matches were `return NextResponse.json({error:...})` response formatters and `console.error`, NOT Supabase operation error checks. Both routes catch ONE error (the initial fetch) across ~450 lines each.** |
| 4 | "`getPortalActiveServices` always returns empty" | Compared `queries.ts:188` hardcoded list vs `pipeline_stages` DB query | **VERIFIED: none of 'Active', 'Intake', 'Setup', 'Processing', 'Review' exist in pipeline_stages** |
| 5 | "Bank feed env vars on Vercel" | Cannot verify from local machine | **ACKNOWLEDGED: requires manual Vercel dashboard check** |
| 6 | "Error propagation is per-file, no central handler" | Partial — explore agent output not extractable | **PARTIAL: confirmed through direct grep, but no systematic map exists** |

### The Pattern
The transparency test revealed that the quantitative claims in the initial draft were mostly accurate (tool count, error count, filter validity). The qualitative claims (architecture, patterns) were harder to verify and required direct code reading. **Going forward, every architectural claim must cite specific file:line evidence.**

---

## 4. Findings: 30+ Bugs, 8 Root Cause Groups

### RC1: `current_stage` Ghost Column (CRITICAL — DATA CORRUPTING)

The database column is `stage`. No `current_stage` column exists. 25+ code references write to a column that doesn't exist. PostgREST silently ignores unknown columns, so the writes return success but the stage data is lost.

| File | Lines | Operation |
|------|-------|-----------|
| `lib/installment-handler.ts` | 90, 189, 334, 340, 344, 351 | SELECT/UPDATE/INSERT |
| `app/api/itin-form-completed/route.ts` | 189, 198, 200, 218 | SELECT/UPDATE/INSERT |
| `app/api/tax-form-completed/route.ts` | 308, 315, 318 | SELECT/READ/UPDATE |
| `app/api/formation-form-completed/route.ts` | 143 | INSERT |
| `app/api/onboarding-form-completed/route.ts` | 141 | INSERT |
| `app/api/closure-form-completed/route.ts` | 162 | INSERT |
| `lib/jobs/handlers/tax-form-setup.ts` | 267, 278, 290 | SELECT/READ/UPDATE |
| `lib/mcp/tools/tax.ts` | 1165, 1175 | SELECT/UPDATE |
| `app/api/portal/search/route.ts` | 63, 70, 75 | SELECT/READ |
| `app/api/internal/ai-assist/route.ts` | 30, 91 | SELECT/READ |

**Client impact:**
- Manuel Burdo ITIN stalled 25 days (B7 in data audit)
- ATCOACHING LLC has 3 stuck SDs (B10)
- 124 active SDs have NULL stage (B1)
- Every client whose submission goes through one of the 5 buggy form-completed routes (formation, onboarding, tax, ITIN, closure): their SD is created or updated via PostgREST which silently ignores `current_stage`, leaving the `stage` column NULL. The `banking-form-completed` route is an exception — directly verified by reading the file: line 141 reads `stage`, line 148 compares `sd.stage`, line 158 writes `stage: "Application Submitted"`. All three references use the correct column name.

### RC2: Portal Queries Use Invalid Filter Values (CRITICAL)

**`lib/portal/queries.ts:188`** — `getPortalActiveServices` filters on `.in('stage', ['Active', 'Intake', 'Setup', 'Processing', 'Review'])`. None of these values exist in `pipeline_stages`. The function always returns empty.

**Action items status filters:**
- `queries.ts:466` — oa_agreements includes `awaiting_signature` (CHECK rejects)
- `queries.ts:474` — lease_agreements includes `awaiting_signature` (CHECK rejects)
- `queries.ts:482` — ss4_applications uses `sent` and `viewed` (CHECK rejects)
- `queries.ts:509` — signature_requests uses `sent` and `viewed` (CHECK only allows draft/awaiting_signature/signed)

**Impact:** Portal nav visibility broken. Action items missing for multiple clients. The "Sign Documents" link hides for clients with MSA, signature_requests, or Form 8832 pending because `pendingSignatures` check ignores those tables.

### RC3: No Automated Portal Provisioning (HIGH)

- **97 contacts** with `portal_tier` set but NO `auth.users` record — they cannot log in at all
- **35 Active accounts** have zero documents (no OA, lease, signature requests) — they see an empty signing page
- **Wizard defaults contradict** — layout defaults to `lead` tier (hides wizard), dashboard defaults to `active` tier (skips WelcomeDashboard). Clients fall through with no wizard entry point.
- **Nicola Bartolini** (`bartolini.nicolaa@gmail.com`) — active contact_tier but no account link, stuck on WelcomeDashboard

### RC4: Wrong Column Names Elsewhere (HIGH)

| Wrong | Correct | Files |
|-------|---------|-------|
| `payment_type` on payments (doesn't exist) | N/A (column doesn't exist at all) | annual-installments:130, overdue-report:30/94, ai-assist:32 |
| `currency` on payments | `amount_currency` | overdue-report:30/92, ai-assist:32 |
| `ein` on accounts | `ein_number` | closure.ts:94/99, ai-assist:29 |
| `name` on accounts | `company_name` | closure.ts:94/98 |

### RC5: Tier Sync Incomplete (MEDIUM but widespread)

- **61 portal tier desyncs** (auth.users vs contacts) — 49 have NULL auth_tier, 3 real clients (marra, awy, johannestabrizi) have `onboarding` vs `active` mismatch
- **56 cancelled/closed accounts** still have `portal_tier = 'active'` or `'full'` — cascade cleanup was opt-in checkbox in StatusChangeDialog, bypassed by MCP/SQL/API changes
- **2 contact/account tier desyncs** (Hamid Oumoumen, Damiano Mocellin)
- **18 users** with lead/onboarding tier but Active accounts — see limited view
- **`upgradePortalTier`** at `lib/portal/auto-create.ts:629-657` uses fragile `listUsers({perPage: 1000})` with email match

### RC6: Multi-Machine Safety Infrastructure Broken (CRITICAL for development)

- **`pre-compact-save.sh:8`** hardcodes `/Users/tonydurante/Desktop/td-operations` — **silently broken on MacBook** (`/Users/tonymac/Developer/td-operations`) and likely Mac Mini
- **`stop-check.sh:7`** same hardcoded path
- **Zero `pre-compaction-auto` records exist in DB** — the safety net has never fired
- **No `machine_id` column** in `session_checkpoints` — 3 machines' checkpoints interleave with no way to separate
- **No optimistic locking** on `dev_tasks.progress_log` — concurrent read-append-write = lost entries
- **`session-context` is last-write-wins singleton** — concurrent updates silently overwrite

### RC7: Missing Route Safety (MEDIUM)

- All 7 form-completed API routes missing `export const maxDuration` — tax-form-completed highest risk (bank statement parsing + Excel generation)
- All 8 critical files have zero transaction safety — crash mid-way = orphaned records across contacts/SDs/tasks/offers
- `tax-form-completed` and `installment-handler` have zero `action_log` writes (zero audit trail)
- `banking-form-completed` uses non-standard `action_log` columns (`actor`, `table_name`, `record_id` vs standard `entity_type`, `entity_id`)

### RC8: Enum Drift — DB Rejects Some Values (HIGH)

Values the code writes that the database REJECTS:
- `portal_tier: "full"` — written at `lib/service-delivery.ts:204` and `contact-actions:222` but NOT in accounts CHECK constraint (only allows lead/onboarding/active/suspended/inactive)
- `account_type: "Formation"` — written at `formation-setup.ts:155` but CHECK only allows Client/One-Time/Partner

Phantom values in code that no row will ever match:
- `"Tax Return Filing"` — `service-delivery.ts:235`, `tax-form-setup.ts:679`, `contact-actions:248` (actual value is "Tax Return")
- `"Billing Annual Renewal"` — `constants.ts:239` (actual value is "Annual Renewal")
- `"DBA"` — `activate-service:48` (not in any enum/CHECK)

`constants.ts` drifts from DB in 8+ enums:
- `TASK_CATEGORY` missing `Formation`
- `CONVERSATION_CHANNEL` missing `Calendly`, `Zoom`
- `SUBMISSION_STATUS` missing `sent`
- `WIZARD_STATUS` missing `reviewed`
- `DEADLINE_STATUS` missing `Cancelled`
- `DOCUMENT_STATUS` missing `processed`
- `PENDING_ACTIVATION_STATUS` missing `expired`, `cancelled`
- `SERVICE_TYPE` missing `CMRA Mailing Address`, `EIN`, `Annual Renewal`
- `OFFER_STATUS` has phantom `under_discussion`, `superseded`
- `PORTAL_TIER` missing `full`, `suspended`, `inactive` (3 values vs 6 actually used)

### Bank feed config issues (separate from RC1-8)
- `/api/cron/stripe-sync` exists but NOT registered in `vercel.json` — never runs
- `lib/plaid.ts` uses module-level initialization (violates CLAUDE.md rule)
- Plaid sync returns `{ok: true, skipped: true}` when credentials missing — appears healthy in logs
- Need to verify on Vercel: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `MERCURY_API_TOKEN`, `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`

### Live Data Violations Summary

| Check | Violations | Severity |
|-------|-----------|----------|
| B1: Active SDs NULL stage | 124 | Latent risk |
| B2: Active SDs invalid stage | 5 (Invictus, Kasabi) | Client-impacting |
| B4: Auth user NULL contact_id | 1 (antonio.schino15) | Client-impacting |
| B5: Portal tier desyncs | 4 | Client-impacting |
| B6: Contact/account tier desyncs | 2 | Client-impacting |
| B7: Form completed, SD stuck | 1 (Manuel Burdo 25 days) | Client-impacting |
| B8: Paid with no active SD | 10 | Latent risk |
| B10: Stuck SDs >14 days | 7 (ATCOACHING 3 SDs) | Client-impacting |

---

## 5. The 5 Architectural Diseases

The bugs above are symptoms. The real problem is structural.

### Disease 1: Organic Growth Without Refactoring

**Evidence from SD write path agent — the timeline tells the story:**

| Date | What was written | Uses correct column? |
|------|-----------------|---------------------|
| Mar 9-11 | `sd_create` + `sd_advance_stage` inline in `operations.ts` | YES (uses `stage`) |
| Mar 16 | `tax-form-completed` | NO (uses `current_stage`) |
| Mar 18 | `itin-form-completed` | NO |
| Mar 19 | `formation-form-completed`, `activate-service` | Mixed (activate uses `stage`, formation uses `current_stage`) |
| Mar 20 | `installment-handler` | NO |
| **Apr 12** | **`advanceServiceDelivery()` extracted to `lib/service-delivery.ts`** | YES |

The form routes did not "bypass" the central function. They PREDATE it by 3 weeks. When the central function was extracted on April 12, nobody went back to refactor the older files. The system grew by ADDING, never by REFACTORING.

**Why this happens specifically in this system:** Multi-machine, multi-session development with context compaction. Session A writes a form handler on iMac. Session B writes another on Mac Mini. Neither knows the other's approach. Neither knows about the correct column name. Each session solves the problem independently.

### Disease 2: Silent Failure by Design

**Evidence from DB protections agent + direct read of `supabase-admin.ts:22`:**

PostgREST silently ignores unknown columns. `supabase-admin.ts` uses `as any` cast (line 22). Combined, these mean:
1. Code writes `{current_stage: "Foo"}` to `service_deliveries`
2. TypeScript compiles (no type info)
3. PostgREST ignores the unknown key
4. Insert returns success with HTTP 200
5. The `stage` column stays NULL
6. Nothing throws, nothing logs, nothing alerts

This is the worst possible failure mode for a system with context loss across machines. A crash would be found in minutes. Silent data loss accumulates for weeks.

### Disease 3: No Single Source of Truth for Schema

Schema is defined in FOUR places that don't agree and aren't generated from each other:

1. **PostgreSQL schema** — columns, types, CHECK constraints, ENUM types (the actual truth)
2. **`lib/constants.ts`** — TypeScript arrays, manually authored, drifted from DB in 8+ places
3. **`pipeline_stages` table** — stage names per service type, referenced by `advanceServiceDelivery()`
4. **Hardcoded strings in 100+ files** — `"Data Collection"`, `"Tax Return Filing"`, `"full"`, etc.

None of these are generated from each other. They drift over time.

### Disease 4: No Lifecycle State Machine

**Evidence from lifecycle agent:**

5 parallel state tracks with no centralized orchestrator:
1. Lead status (New → Converted)
2. Pending activation (awaiting_payment → activated)
3. Account status (Pending Formation → Active → Closed)
4. Portal tier (lead → onboarding → active → full)
5. SD status (active → completed)

No code validates transitions. `changeAccountStatus` accepts any from→to. Cascades are opt-in (StatusChangeDialog checkbox). Result: **56 cancelled/closed accounts still have active portal tiers** because the cascade was skipped.

`advanceServiceDelivery()` is the closest thing to a state machine (for SDs) and `upgradePortalTier` for tiers (prevents downgrades). But there's no centralized lifecycle orchestrator for the full client journey.

### Disease 5: Zero Test Coverage on Critical Code

**Evidence from test coverage agent:**

22 unit test files exist. 287 test cases. But the testing effort is **inverted**:

| Category | Lines | Tests |
|----------|-------|-------|
| Pure utility functions (auth, classification, validation, OCR) | ~1,500 | 287 |
| Business-critical code (SD create/advance, form handlers) | 3,368 | **0** |

The safest code (pure functions with no side effects) has the most tests. The riskiest code (multi-step operations with side effects, external APIs, and database writes) has zero tests.

**The smoking gun:** `tests/unit/status-validation.test.ts:76` explicitly confirms `service_deliveries` is in the "unmapped" table list — `validateStatusField("service_deliveries", {status: "whatever"})` returns null. Any value passes validation. The test codifies that the table has no guardrails.

---

## 6. Devil's Advocate — 4 Rounds

### Round 1: Is the phase order right?

**Original plan:** Phase 0 (fix bugs) → Phase 1 (type safety) → Phase 2 (DAL) → Phase 3 (refactor) → Phase 4 (DB) → Phase 5 (monitor) → Phase 6 (test) → Phase 7 (session infra)

**Challenge:** Should Phase 1 (type safety) come BEFORE Phase 0? If we generate types first, TypeScript catches all the wrong column names automatically. Then Phase 0 becomes "fix the compile errors."

**Counter-challenge:** Replacing the `as any` proxy in `supabase-admin.ts:22` is a non-trivial refactor. Every file importing `supabaseAdmin` needs to work with the typed client. Some files may use patterns that don't type-check cleanly (e.g., dynamic column names from user input). Starting with type safety could BLOCK all other work while we fix TypeScript errors that aren't actually bugs.

**Better answer:** Phase 0 does targeted symptomatic fixes without touching architecture. Phase 1 adds type safety which prevents recurrence. This avoids a 1-2 day gap where the system is broken while type errors are cleaned up. The ordering is correct.

**Second challenge:** But if we fix bugs in Phase 0 and then introduce types in Phase 1, won't the types catch MORE bugs that Phase 0 missed? Aren't we fixing the same file twice?

**Counter-counter:** Yes, but the Phase 0 fixes are a 10-minute find/replace (`current_stage` → `stage`). Phase 1's job is to ensure they can never come back. The overlap is minimal.

### Round 2: Will the central DAL actually reduce bugs?

**Original plan:** Phase 2 creates `lib/operations/` with central functions. Routes call them instead of raw Supabase.

**Challenge:** The form-completed routes do more than SD operations. They also create contacts, send emails, create tasks, upload to Drive, process referrals, parse bank statements. A central DAL only covers ONE step per route. The other steps are still ad-hoc. We've just moved the bugs.

**Counter-challenge:** True — but the audit shows that the **critical** bugs are in the SD operations specifically (RC1, RC4 partial, RC8 partial). The email sending, Drive uploads, and task creation don't show up in the bug list. They work. The highest-ROI target is service_deliveries + payments + contacts (the 3 tables with client-impacting bugs).

**Second challenge:** But if we only DAL the 3 critical tables, new bugs will emerge in the non-DAL paths. Won't we be playing whack-a-mole?

**Counter-counter:** Yes, but at a manageable pace. The DAL doesn't need to cover every operation. It needs to cover the SHARED operations (SD create, SD advance, tier upgrade, contact upsert) that multiple files do differently. Unique business logic (bank statement parsing) stays in its route — there's only one of it, so there's no drift risk.

**Better answer:** Phase 2 creates DAL for OPERATIONS THAT ARE DUPLICATED across files. Not for everything. The principle: "any operation that exists in more than one place must exist in exactly one place."

### Round 3: Can multi-machine execution work, or will merge conflicts dominate?

**Original plan:** Partition work by file across iMac/Mac Mini/MacBook to parallelize execution.

**Challenge:** Git merge conflicts are painful. 3 machines pushing in parallel to the same branch means constant rebases. Every rebase risks breaking something. The parallelization savings are eaten by merge overhead.

**Counter-challenge:** The plan already partitions by FILE, not by task. If Machine A works on files A-L, Machine B on M-S, Machine C on T-Z, there are NO conflicts. Each machine pushes its own files. Merges are trivial.

**Second challenge:** But cross-file dependencies exist. If Machine A refactors `service-delivery.ts` (used by Machines B and C's files), Machine B and C get blocked. They can't finish their refactors until Machine A pushes and they pull.

**Counter-counter:** Yes — this means there's a DEPENDENCY ORDER even within a phase. Foundation files (`service-delivery.ts`, `database.types.ts`, `supabase-admin.ts`) are changed FIRST on one machine. Then all three machines can refactor their partitioned files against the stable foundation. This is how modular refactoring works anyway.

**Third challenge:** Context loss between machines. Machine B doesn't remember what Machine A just did. How does Machine B know which foundation files are stable and which are still being edited?

**Counter-counter-counter:** This is exactly what the session handoff infrastructure is for. The fix in Phase 7 (machine_id in checkpoints, workstream-aware restore query, fixed hook scripts) is a PRE-REQUISITE for multi-machine execution. If we try to parallelize before Phase 7, we get the problems we already have. **Phase 7 must run first on one machine before any parallel work begins.**

**Better answer:** Sequence is:
1. ONE machine runs Phase 0 (bugs) + Phase 7 (session infra) FIRST
2. Then ONE machine runs Phase 1 (types) + Phase 2 (DAL scaffolding) + Phase 4 (DB migrations) — these are foundation
3. Then THREE machines run Phase 3 (refactor routes) + Phase 5 (health monitoring) + Phase 6 (tests) in parallel

The first two phases can't be parallelized. The second three can.

### Round 4: Does the canonical-operation pattern solve session drift?

**Original plan:** Create `lib/operations/` where every shared operation is a named canonical function. Sessions use these instead of ad-hoc SQL.

**Challenge:** What prevents Session A from creating a canonical operation and Session B from not knowing it exists and creating another one? The whole problem is context loss across sessions.

**Counter-challenge:** Three enforcement mechanisms:
1. **`lib/operations/INDEX.md`** — always-updated list of all canonical operations. Read at session start.
2. **CLAUDE.md rule** — "Before writing SQL or calling `.from(critical_table)` directly, check `lib/operations/` for an existing function."
3. **Lint rule or test** — grep-based test that fails if ANY file outside `lib/operations/` calls `.from('service_deliveries')` or similar for critical tables. This is a HARD enforcement — the build breaks on violation.

**Second challenge:** "Hard enforcement breaks the build" sounds good until you need to hotfix a client issue. If every fix requires going through `lib/operations/`, you can't hotfix — you have to add an operation first. Too much friction.

**Counter-counter:** This is actually the GOAL. The friction is the feature. If every client fix MUST go through a canonical operation, the client care anti-pattern (see Section 7) is eliminated by construction. Yes, hotfixes take 5 extra minutes. But they also produce reusable operations that help future clients.

**Third challenge:** But what about one-off cases? Sometimes a client has a unique issue that doesn't fit any canonical operation. Forcing it into the system creates bloated operations with special cases.

**Counter-counter-counter:** True one-offs go through `execute_sql` (with explicit comment explaining why). The test should allow `execute_sql` but fail on direct `.from()` calls. This creates a tiered system:
- **Tier 1** — canonical operation (preferred, used for anything reusable)
- **Tier 2** — `execute_sql` with comment (for one-offs)
- **Tier 3** — direct `.from()` (FORBIDDEN for critical tables)

**Better answer:** The canonical operation pattern solves drift IF combined with automated enforcement and a tiered system. Without enforcement, it's just another thing to remember.

---

## 7. The Client Assistance Anti-Pattern

Antonio described the following cycle:

1. Client has an issue (can't see documents, wrong tier, missing invoice)
2. Open Claude Code session on any available machine
3. Claude investigates, finds the issue in code or data
4. Claude writes a fix in the backend (e.g., `UPDATE contacts SET portal_tier = 'active' WHERE id = ...`)
5. The fix resolves THIS client's issue
6. Claude then builds CRM UI so the same fix can be done from the dashboard
7. The UI build exposes OTHER bugs (e.g., the dashboard doesn't have a tier change button because the old one was broken)
8. New session to fix the new bugs
9. The new session might approach the SAME kind of fix differently
10. Over time, the system has 3-5 different ways to "change a portal tier" scattered across files

**Root cause:** Steps 4 and 6 happen in the same session but produce DIFFERENT code. The backend fix is a raw SQL. The UI build is a server action. They do the same thing but are implemented twice. Next time the issue happens, the session picks whichever version it finds first — or writes a third version.

### Solution: "Operation-First" Development

Reverse the order. Instead of "fix client, then build UI":

1. **Client has issue.**
2. **Check `lib/operations/` for an existing operation that would fix it.**
3. **If it exists** — call it directly (via MCP tool). Done. Client fixed.
4. **If it doesn't exist** — BEFORE fixing this client, CREATE the canonical operation:
   - Add function to `lib/operations/`
   - Add MCP tool that wraps it
   - Add CRM UI button (if it makes sense)
   - THEN use it to fix this client
5. **Record the fix** — a `client_fixes` table records: client_id, issue, operation_used, timestamp, session_id.

The friction is ~5 extra minutes per new operation. In return:
- Every client fix is reusable
- No drift (one operation, one place)
- UI and backend stay in sync because they share the operation
- `client_fixes` table gives you a history of what's been done

### Example: "Client can't see their documents"

**Before (current anti-pattern):**
```
Session A (iMac): 
  - Investigates. Finds portal_tier='lead' when it should be 'active'
  - Runs UPDATE contacts SET portal_tier='active' WHERE email='xyz@example.com'
  - Builds CRM dashboard button: server action does the same UPDATE
  - Exposes: auth.users tier not synced
  - Runs UPDATE auth.users SET raw_app_meta_data = ...
  - Adds code to server action for auth sync
  - Pushes

Session B (Mac Mini), later:
  - Same issue, different client
  - Runs UPDATE contacts WHERE id=... (slightly different approach)
  - Doesn't know about the server action from Session A
  - Writes new SQL
  - System now has 3 ways to "fix portal tier"
```

**After (operation-first):**
```
Session A (any machine):
  - Investigates. Finds portal_tier='lead' when it should be 'active'
  - Checks lib/operations/portal-tier.ts — no upgradeClientTier() exists
  - Creates lib/operations/portal-tier.ts with upgradeClientTier(contactId, targetTier)
    * Updates contacts.portal_tier
    * Updates accounts.portal_tier (cascade)
    * Updates auth.users.raw_app_meta_data.portal_tier (sync)
    * Validates target tier is in PORTAL_TIER enum
    * Logs to action_log
  - Creates MCP tool portal_tier_upgrade that wraps it
  - Creates CRM button that calls the MCP tool
  - Calls portal_tier_upgrade(contact_id, 'active') to fix this client
  - Records in client_fixes table
  - Pushes

Session B (any machine), later:
  - Same issue
  - Reads lib/operations/INDEX.md
  - Sees upgradeClientTier exists
  - Calls portal_tier_upgrade(contact_id, 'active')
  - Done in 30 seconds
```

### Enforcement

CLAUDE.md rule addition:
```
## Operation-First Rule — MANDATORY

Before writing ANY raw SQL or direct .from() call on:
- service_deliveries
- payments
- contacts
- accounts
- auth.users

Check lib/operations/INDEX.md for an existing canonical operation.
If one exists, use it.
If not, CREATE one before fixing the client. The client fix IS the test of the new operation.

Exceptions: read-only queries via execute_sql with a comment explaining the one-off nature.
```

Automated test (`tests/unit/operation-first.test.ts`):
```typescript
// For each critical table, grep for .from("table") and .update/insert/upsert
// FAIL if any file outside lib/operations/ writes to a critical table
// ALLOW execute_sql calls (read-only or one-off)
```

---

## 8. Restructured Plan v2

Phases updated based on devil's advocate. Multi-machine assignments follow Round 3 conclusions.

### Phase 0: Emergency Fixes + Safety Infrastructure (ONE MACHINE — MacBook for mobility)

**Must run first because:** These fixes are immediate client-impact blockers AND the safety infra gates all future multi-machine work.

1. Fix `pre-compact-save.sh:8` and `stop-check.sh:7` — replace hardcoded path with `$(cd "$(dirname "$0")/../.." && pwd)`
2. Add `machine_id` column to `session_checkpoints`, `dev_tasks` (via `execute_sql`)
3. Update `session_checkpoint` MCP tool to capture `$(hostname -s)`
4. Replace session start restore query with workstream-aware version
5. Fix `current_stage` → `stage` in 10 files (find/replace)
6. Fix fabricated stage values in `queries.ts`
7. Fix wrong column names (`payment_type`, `currency`, `ein`, `name`) in 4 files
8. Fix invalid status filters in `queries.ts:466,474,482,509`
9. Fix `portal_tier: "full"` and `account_type: "Formation"` writes
10. Stage 0 verification: re-run B1-B10 invariant queries. Confirm violations reduced.

**Why MacBook:** Antonio follows the plan across physical locations. MacBook is mobile. The safety infra is LOCAL to the machine running it (hooks are per-machine), so fixing them where you are is correct.

### Phase 1: Type Safety Foundation (ONE MACHINE — iMac preferred for stability)

1. Run `supabase gen types typescript --project-id <id> > lib/database.types.ts`
2. Add to `package.json` scripts: `"gen:types": "supabase gen types typescript ..."`
3. Replace `lib/supabase-admin.ts` Proxy pattern with typed client:
   ```typescript
   import { Database } from './database.types'
   import { createClient } from '@supabase/supabase-js'
   
   let _client: ReturnType<typeof createClient<Database>> | null = null
   export function getSupabaseAdmin() {
     if (!_client) {
       _client = createClient<Database>(
         process.env.NEXT_PUBLIC_SUPABASE_URL!,
         process.env.SUPABASE_SERVICE_ROLE_KEY!
       )
     }
     return _client
   }
   ```
4. Run `npm run build` and fix all TypeScript errors that surface. These errors ARE bugs.
5. Regenerate `lib/constants.ts` from DB enums (or make it import from `database.types.ts`)

**Why ONE machine:** This touches every file that imports `supabaseAdmin` (~100+). Must be coherent.

### Phase 2: Canonical Operations (ONE MACHINE — foundation work)

1. Create `lib/operations/` directory
2. Extract `createServiceDelivery()` from `sd_create` MCP tool logic (`operations.ts:938-1079`) into `lib/operations/service-delivery.ts`
3. Move existing `advanceServiceDelivery` from `lib/service-delivery.ts` into `lib/operations/service-delivery.ts`
4. Create `lib/operations/portal-tier.ts` with `upgradeClientTier(contactId, targetTier)` — handles contact + account + auth.users sync
5. Create `lib/operations/client-lifecycle.ts` with `convertLeadToClient`, `onboardClient`, `activateClient`
6. Create `lib/operations/INDEX.md` listing all canonical operations with one-line descriptions
7. Add CLAUDE.md rule about operation-first development
8. Create test `tests/unit/operation-first.test.ts` that fails if any file outside `lib/operations/` writes to critical tables

### Phase 3: Migrate Bypass Routes (THREE MACHINES IN PARALLEL)

**Partition by file:**

| Machine | Files |
|---------|-------|
| **iMac** | `formation-form-completed`, `onboarding-form-completed` |
| **Mac Mini** | `tax-form-completed`, `closure-form-completed` |
| **MacBook** | `itin-form-completed`, `banking-form-completed`, `installment-handler.ts` |

Each machine refactors its files to use canonical operations. No two machines touch the same file. Merge conflicts are impossible.

### Phase 4: DB Enforcement (ONE MACHINE — iMac, sequential migrations)

1. Migrate 124 NULL-stage active SDs (assign correct stages based on service_type + pipeline_stages first row)
2. Add `NOT NULL` constraint on `service_deliveries.stage`
3. Add BEFORE INSERT/UPDATE trigger on `service_deliveries` validating `(service_type, stage)` against `pipeline_stages`
4. Add `full` to accounts `portal_tier` CHECK constraint (or update code to not use it)
5. Add `Formation` to accounts `account_type` CHECK constraint (or update code)
6. Clean up 56 cancelled/closed accounts with active portal tiers (set to `inactive`)

**Why ONE machine:** Sequential DB migrations. Each depends on the previous.

### Phase 5: Health Monitoring (ONE MACHINE — MacBook during travel)

1. Create `health_violations` table (`id, check_name, severity, details jsonb, record_ids text[], created_at, resolved_at`)
2. Create `/api/cron/health-check` route running B1-B10 invariant queries
3. Register in `vercel.json` for daily execution
4. Build dashboard widget on CRM home showing violation count + severity
5. Auto-create CRM tasks for client-impacting violations

### Phase 6: Test Coverage (THREE MACHINES IN PARALLEL)

**Partition by test category:**

| Machine | Test files |
|---------|-----------|
| **iMac** | Schema validation tests (constants vs DB enum/CHECK) |
| **Mac Mini** | Canonical operation unit tests (createServiceDelivery, advanceServiceDelivery, upgradeClientTier) |
| **MacBook** | Form route integration tests (each form creates SD with correct stage) |

### Phase 7: Cross-Session Safety Hardening (already partially done in Phase 0)

Remaining:
1. Add `commit_hash` and `branch` columns to `session_checkpoints`
2. Add optimistic locking to `dev_tasks.progress_log` (version column or `updated_at` in WHERE)
3. Add merge guard to `session-context` sysdoc updates

---

## 9. Multi-Machine Execution Matrix

| Phase | Mode | Machines | Rationale |
|-------|------|----------|-----------|
| 0 | Sequential | 1 (MacBook) | Safety infra must land before parallelization |
| 1 | Sequential | 1 (iMac) | Coherent refactor across 100+ files |
| 2 | Sequential | 1 (iMac) | Foundation design, single author |
| 3 | **Parallel** | 3 (all) | File-partitioned, no conflicts |
| 4 | Sequential | 1 (iMac) | Sequential DB migrations |
| 5 | Sequential | 1 (MacBook) | Small scope, mobile-friendly |
| 6 | **Parallel** | 3 (all) | Test-partitioned, no conflicts |
| 7 | Sequential | 1 (any) | Small scope |

**Total time estimate with parallelization:** Roughly 60-70% of sequential time. The parallel phases (3 and 6) are the largest by volume.

**Critical rule:** Before starting any parallel phase, the previous sequential phase MUST be pushed to `main` and pulled by all 3 machines. Verify with `git log origin/main --oneline | head`.

---

## 10. Emergency Protocol (Band-aids During Restructure)

Antonio's decision: follow the restructure plan as the main track, but use Claude Code in the backend to solve temporary client issues so clients don't suffer during the rebuild.

**The problem:** Emergency fixes during the restructure risk creating new drift.

**The rule:** Emergency fixes MUST follow these constraints:

1. **Must use canonical operations if they exist.** If `upgradeClientTier` exists in `lib/operations/`, USE IT. Don't write new SQL.
2. **If no canonical operation exists**, the fix goes through `execute_sql` with a comment:
   ```sql
   -- EMERGENCY FIX 2026-04-XX — client: XYZ LLC — reason: portal tier desync
   -- TODO: migrate to canonical operation in Phase 3
   UPDATE contacts SET portal_tier = 'active' WHERE id = ...
   ```
3. **Every emergency fix is logged** in a `client_emergency_fixes` table (or `action_log` with a specific tag) so it can be audited later.
4. **Never modify files being refactored in parallel.** Check the current parallel phase. Avoid those files.
5. **No new UI without a canonical operation.** If the fix needs a UI button, create the operation first (Phase 2 style), then the button.

This ensures emergency fixes don't create new code paths. They either use existing operations or document their one-off nature for later migration.

---

## 11. Verification Plan

Each phase has acceptance criteria. Do not proceed to the next phase until the previous passes.

**Phase 0:**
- [ ] `grep -rn "current_stage" lib/ app/` returns zero results
- [ ] B1-B10 invariant queries run. B7 (Manuel Burdo) resolved. B10 stuck count decreased.
- [ ] `hostname -s` written to a test checkpoint. Workstream restore query returns expected results.

**Phase 1:**
- [ ] `lib/database.types.ts` exists and was generated from DB
- [ ] `npm run build` passes with zero TypeScript errors
- [ ] Intentionally type a wrong column name → build fails as expected
- [ ] `lib/constants.ts` values match DB enum/CHECK values (schema validation test)

**Phase 2:**
- [ ] `lib/operations/INDEX.md` exists with all canonical operations listed
- [ ] `createServiceDelivery()` and `advanceServiceDelivery()` exist as exported functions
- [ ] `lib/operations/portal-tier.ts` has `upgradeClientTier`
- [ ] `tests/unit/operation-first.test.ts` passes (or fails on intentional violation)

**Phase 3:**
- [ ] Submit each form (formation, onboarding, tax, ITIN, closure, banking) via `?preview=td`
- [ ] Verify SD is created with correct `stage` (NOT NULL, in `pipeline_stages`)
- [ ] Verify `action_log` entry exists
- [ ] Verify `newSd.stage === expectedFirstStage`

**Phase 4:**
- [ ] 124 NULL-stage SDs migrated to correct stages
- [ ] `ALTER TABLE service_deliveries ADD CONSTRAINT stage NOT NULL` succeeds
- [ ] Attempt `INSERT` with invalid stage → DB rejects
- [ ] 56 cancelled/closed accounts have `portal_tier = 'inactive'`

**Phase 5:**
- [ ] `/api/cron/health-check` runs manually, returns B1-B10 results
- [ ] `health_violations` table populates
- [ ] Dashboard widget shows violation count
- [ ] CRM tasks auto-created for client-impacting violations

**Phase 6:**
- [ ] `npm run test:unit` passes
- [ ] Schema validation test fails on intentional drift
- [ ] Form route test fails on intentional `current_stage` regression

**Phase 7:**
- [ ] `session_checkpoints` has `machine_id`, `commit_hash`, `branch` columns
- [ ] Concurrent `dev_task_update` from 2 machines doesn't lose progress entries
- [ ] `sysdoc_update` on `session-context` warns on concurrent modification

---

## 12. What's NOT in Scope

Explicitly OUT of scope for this plan:
- Building new client-facing features
- Migrating to a different database or framework
- Rewriting the CRM dashboard UI
- Performance optimization (unless it's a bug)
- Documentation for users (only internal developer docs)
- Refactoring working code that doesn't appear in the bug list (e.g., Gmail tools, Drive tools, OAuth flow)

**Principle:** The restructure should be the minimum work needed to prevent recurrence of the bugs found. Not a full rewrite.

---

## 13. Open Questions for Antonio

Before executing, I need answers on:

1. **Vercel env vars for bank feeds** — Are `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `MERCURY_API_TOKEN`, `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` configured on Vercel? (I cannot check from local.)
2. **`portal_tier: "full"` — which side wins?** Should we add `full` to the accounts CHECK constraint (allow code to keep writing it) OR change code to not write `full` (use a different column like `subscription_level`)?
3. **`account_type: "Formation"` — same question** — should `Formation` be added to CHECK, or should the code use `Client` with a different discriminator?
4. **Phase 3 partitioning** — Is the iMac/Mac Mini/MacBook split OK, or do you want a different allocation based on which machine is where?
5. **Emergency protocol during execution** — how many client emergencies per week do you typically handle? This informs whether the operation-first rule adds significant friction.

---

## 14. Change Log

- 2026-04-14 04:30 — Initial audit complete (10 agents)
- 2026-04-14 04:45 — Deep architectural analysis complete (4+2 agents)
- 2026-04-14 05:00 — Transparency test verified
- 2026-04-14 05:10 — Restructured plan v2 with 4 devil's advocate rounds
- 2026-04-14 05:15 — Multi-machine execution strategy
- 2026-04-14 05:20 — Client assistance anti-pattern solution
- 2026-04-14 — DOCUMENT COMPLETE. Awaiting Antonio's decisions on open questions.
- 2026-04-14 — **Corrections after second-pass verification:**
  - Row 3 of transparency test corrected: error check counts in form routes were misread. Both `itin-form-completed` and `formation-form-completed` have exactly 1 Supabase error check each (both on line 41 for `subErr`). Initial count of "5" for formation was a pattern-matching artifact that included `NextResponse.json({error:...})` response formatters and `console.error`, not actual Supabase `.error` checks. Corrected via re-grep with `if\s*\(\s*\w*[Ee]rr`.
  - Client impact bullet narrowed from "Every client who submits a form" to the specific 6 buggy form-completed routes. Banking-form-completed is an exception that uses the correct `stage` column.
  - DB enforcement claim re-verified via three direct `execute_sql` queries (columns, constraints, triggers).
  - 206 tool count re-verified via spot-check of `calendly.ts` (3 matches at 3 distinct lines, each a unique tool registration).
  - `banking-form-completed` column usage re-verified by directly reading `app/api/banking-form-completed/route.ts` lines 135-164. Confirmed: line 141 selects `stage`, line 148 compares `sd.stage`, line 158 writes `stage`. Corrected the "6 buggy routes" phrasing to "5 buggy routes" since banking uses the correct column name. The prior claim referenced Agent C's earlier output but was re-verified with direct source read.
