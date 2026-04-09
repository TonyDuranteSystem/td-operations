# CLAUDE.md Migration — Audit Table + Locked Decisions

**Date:** 2026-04-09
**Source:** `/Users/10225office/Developer/td-operations/CLAUDE.md` (483 lines, read in full in-turn during previous session)
**Status:** Decisions LOCKED. Ready for drafting in fresh session.
**Handoff file location:** `/tmp/claude-md-audit-table-2026-04-09.md`

---

## HOW TO USE THIS FILE (fresh session instructions)

1. Read this entire file before doing anything else.
2. Read the current `CLAUDE.md` in full (in-turn, cite the read).
3. Verify `qa-staff` privileges (see "VERIFICATION NEEDED" section below) BEFORE moving credentials.
4. Create a git branch: `claude-md-migration-2026-04-09`.
5. Draft the new `CLAUDE.md` with tier markers, following the audit table and locked decisions EXACTLY.
6. Run the trace check (described below).
7. Present the full diff to the user for DP1.3 approval.
8. Do NOT merge without approval.

**FINAL RULE (non-negotiable):**
- No creativity during drafting.
- Follow the audit table.
- Follow the locked decisions.
- Preserve every rule (trace-check verifies this).
- Do not add new rules.
- Do not delete rules outside the explicit DELETE/CONSOLIDATE rows in the audit table.

---

## LOCKED DECISIONS

### A — Session Start SQL
**Decision:** Keep SQL queries inline in Tier 1, verbatim. No indirection.

**Implementation:**
- Both SQL queries (in_progress/todo + recent done) live inline in the T1 Session Start section.
- Column lists, filters, ORDER BY, LIMIT are preserved exactly as in the current file (lines 47–49).
- No reference to T3. SQL is at the top of the file.

---

### B — Anti-Compaction Compression
**Decision:** Keep core rule + stakes framing + inline what-to-save checklist. Tight, no expansion.

**Implementation:**
- **T1 — R047 verbose** (single rule, ~8–10 lines):
  - Core imperative: "Save IMMEDIATELY after every significant action"
  - Stakes framing: include the "2+ hours of lost recovery time" consequence language from current lines 167–168
  - Inline 5-item what-to-save checklist (condensed from current lines 201–206):
    1. What was built/changed (files)
    2. What was deployed (commit hash)
    3. What is PENDING (next steps, blockers)
    4. Config/credentials added (reference, not values)
    5. Specifics: file paths, line numbers, IDs, exact values
- **T2 — R051:** "Subagents write results to Supabase BEFORE returning. Chat gets compact summary."
- **T2 — R053:** "Before INSERT on `dev_tasks`, SELECT first to dedupe. Update existing, never duplicate." Anchor: `{table:dev_tasks}`
- **T3-OPS:** hook inventory, save methods (session_checkpoint vs dev_tasks), recovery procedure, operational subfolder pattern, Claude.ai reminder equivalent.

**Total T1+T2 budget for this section:** ~12 lines. Do NOT exceed.

---

### C — Verification Rules
**Decision:** Keep 3 distinct rules under one "Verification Protocol" heading. Do NOT merge content.

**Implementation:**
- Single heading: `## Verification Protocol — MANDATORY`
- Three sub-rules, each with its own imperative + specific guidance + stakes framing:
  - **R055 — Verify Before Claiming** (epistemic: about statements)
  - **R056 — Verify Before Acting** (operational: about questions to user)
  - **R057 — Check Before Acting** (temporal: about duplication across sessions/machines)
- Each sub-rule keeps its trigger-specific guidance from the current file (lines 233–257).
- Do NOT combine the three into one rule. Do NOT strip the stakes language.

---

### D — Decision Propagation — 3-CATEGORY TYPE-AWARE MODEL
**Decision:** Type-aware propagation with **3 categories** (not 5). Must be usable under pressure.

**Implementation in T1:**

```
When a decision is made, classify it into ONE of 3 categories and propagate
to the targets for that category. If ambiguous, treat as all three.

CATEGORY 1 — BEHAVIOR (how Claude acts)
  Examples: new verification rule, new output format, new tool-use policy
  Targets: CLAUDE.md + lib/mcp/instructions.ts + session-context + session_checkpoint

CATEGORY 2 — BUSINESS / SOP (what to do for clients)
  Examples: pricing change, new workflow step, compliance rule change
  Targets: Master Rules KB + sop_runbooks + session-context + session_checkpoint

CATEGORY 3 — SYSTEM / INFRA (what's running where)
  Examples: new integration, config change, env variable, infrastructure update
  Targets: session-context + session_checkpoint

ALWAYS update session-context and session_checkpoint regardless of category.
```

**Rationale summary** (do not include in the T1 rule, just for fresh session reference):
- Every path includes session-context + checkpoint (non-negotiable for cross-session/cross-compaction continuity).
- Category 1 covers both Claude Code (CLAUDE.md) and Claude.ai connector (instructions.ts) because behavioral rules must stay consistent across both runtimes.
- Category 2 covers canonical business logic (KB) and workflow (SOP). Both are queried by both Claude instances during operations.
- Category 3 is minimal — infra changes don't need to propagate to rule stores.
- Ambiguous cases: update all three categories = update all 6 targets = same as current 6-target rule. Safety fallback preserved.

**What changes vs current CLAUDE.md (lines 274–282):**
- Current rule is unconditional 6-target update.
- New rule is 3-category classifier with conditional targets.
- Old rule preserved as the "ambiguous fallback" — no safety loss.

---

### E — Credentials
**Decision:** Split. Client credentials stay in T3-QA of CLAUDE.md. Admin credentials move OUT to gitignored storage. **Verification required before moving.**

**Implementation:**
- **Client test account stays** (`uxio74@gmail.com` / `TDqa-client-2026!` / Uxio Test LLC `30c2cd96-03e4-43cf-9536-81d961b18b1d`) — in T3-QA appendix.
- **Admin test account moves** — but ONLY after verifying actual privileges (see VERIFICATION NEEDED below).
  - If admin has full CRM privileges → move to `.env.local` (gitignored per `.gitignore` line 16 pattern `.env*.local`, verified in prior session).
  - If admin is narrowly scoped (read-only, test env only) → keep in CLAUDE.md T3-QA with scope note.
- In T3-QA, replace the admin credentials block with a pointer (pattern): "Admin credentials: stored in `.env.local` as `QA_ADMIN_EMAIL` / `QA_ADMIN_PASSWORD`. Copy from `.env.local.example` template."
- Optionally create `.env.local.example` (committed, no secrets) listing the variable names.

---

## VERIFICATION NEEDED BEFORE DRAFTING (fresh session must do first)

1. **Verify `qa-staff@tonydurante.us` privileges** — query Supabase `auth.users` or equivalent:
   ```sql
   SELECT id, email, raw_app_meta_data, created_at
   FROM auth.users
   WHERE email = 'qa-staff@tonydurante.us';
   ```
   Check `raw_app_meta_data` for `role` and any scoping flags. Decision E execution depends on the result:
   - `role = 'admin'` with no scoping → MOVE credentials out
   - `role = 'test'` or narrowly scoped → KEEP in T3-QA with scope note

2. **Re-read current CLAUDE.md in full** (in-turn citation) — the audit table below was built from a read in the previous session. Fresh session must re-read to confirm no changes occurred.

3. **Re-read `.husky/pre-commit`, `.claude/settings.json`, `.gitignore`** — for any T2 rules that reference current hook state, verify the references still resolve.

4. **Grep `app/api/[transport]/route.ts`** — for any T2 rules with `{tool:X}` anchors, verify the tool is still registered.

---

## DRAFTING CONSTRAINTS

1. **Tier markers required** (exact format):
   ```
   <!-- TIER1:START -->
   ... content ...
   <!-- TIER1:END -->

   <!-- TIER2:START -->
   ... content ...
   <!-- TIER2:END -->

   <!-- TIER3:START -->
   ... content ...
   <!-- TIER3:END -->
   ```

2. **Anchor syntax for T2 rules** (inline in the rule text):
   - `{file:path/to/file.ts}` — file anchor
   - `{table:table_name}` or `{table:table.column}` — schema anchor
   - `{tool:tool_name}` — MCP tool anchor
   - Anchors are the hooks for Phase 5 semantic drift detection.

3. **T1 verbose format** for behavioral rules:
   - Imperative first line
   - Reason/context (1–2 sentences)
   - Stakes framing (what breaks if ignored)
   - Where applicable: example of the bad thing being prevented

4. **T2 one-liner format** for error-magnet rules:
   - Single line imperative
   - Inline anchor where applicable
   - No explanation (details live in T3 reference)

5. **T3 format** for reference content:
   - Sub-sections by topic: `### DEV reference`, `### QA reference`, `### GIT reference`, `### OPS reference`, `### Architecture reference`
   - Preserve original content from source file where possible
   - Update stale counts during migration (see "STALE CONTENT TO FIX" below)

6. **Trace check requirement:**
   - After writing the draft, for every row in the audit table with action ≠ DELETE:
     - Extract a distinctive keyword from the original text
     - Grep the new file for the keyword
     - Mark PASS if found, FAIL if not
   - Any FAIL must be fixed before DP1.3 presentation
   - 100% pass rate required on non-deleted rows

7. **Stale content to fix during migration:**
   - Line 5: "MCP server (78 tools)" → update to actual count (check via grep of route.ts)
   - Line 228: "59 articles" → update to actual count (was ~113 per earlier SQL query)
   - Line 297: "15 tool files" → update to actual count (was ~33 per project-state sysdoc)
   - Line 403–406: "Module-Level Initialization" is misplaced inside Git Safety section → move to T3-DEV

8. **Forbidden actions during drafting:**
   - Do not add new rules that are not in the audit table
   - Do not delete rules outside the explicit DELETE/CONSOLIDATE rows
   - Do not reorder tiers
   - Do not change rule wording beyond compression per the assigned Action column
   - Do not add examples or commentary that weren't in the source file (except the what-to-save checklist in R047 per decision B)

---

## AUDIT TABLE

**Legend:**
- T1 = per-turn behavioral tier
- T2 = error-magnet one-liner tier
- T3-ARCH / T3-DEV / T3-QA / T3-GIT / T3-OPS / T3-IDENT = Tier 3 reference appendix subsections
- DELETE = remove (with justification)
- CONSOLIDATE-> RXXX = merge into target rule ID
- Column "Line" = line number in current CLAUDE.md

### Section 1 — Identity (lines 3–5)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R001 | 4 | "You are working on **td-operations**..." | T1 | preserve | — | Identity every turn |
| R002 | 5 | "This repo contains: MCP server (78 tools)..." | T3-ARCH | move + update count | — | Reference; stale tool count |

### Section 2 — Architecture (lines 7–27)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R003 | 8–11 | Supabase/Drive/Vercel/GitHub roles | T3-ARCH | move | — | Reference |
| R004 | 13–18 | Four domains table | T3-ARCH | move | — | Reference |
| R005 | 17 | "td-operations.vercel.app ... NEVER send to clients" | T2 | one-liner | `{file:lib/config.ts}` | Error-magnet |
| R006 | 20–27 | "Two Products in One Repo" table | T3-ARCH | move | — | Reference |

### Section 3 — Work Discipline (lines 29–41)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R007 | 30 | "Plan first, build second..." | T1 | preserve verbose | — | Behavioral — anti-superficial |
| R008 | 31 | "Finish one thing completely before starting the next" | T1 | preserve verbose | — | Behavioral |
| R009 | 32 | "Group related work" | T1 | preserve | — | Behavioral |
| R010 | 33 | "Stay on scope" | T1 | preserve | — | Behavioral |
| R011 | 34 | "Be honest about code pushed ≠ feature working" | T1 | preserve verbose | — | Behavioral; strong framing |
| R012 | 37 | "All client-facing URLs MUST use APP_BASE_URL" | T2 | one-liner | `{file:lib/config.ts}` | Error-magnet, hook-enforced |
| R013 | 38 | ".husky/pre-push hook blocks hardcoded domains" | T3-GIT | move | — | Reference |
| R014 | 39 | "OAuth ISSUER and QB_REDIRECT_URI stay on td-operations.vercel.app" | T3-ARCH | move | — | Reference constraint |
| R015 | 40 | "NEVER remove any domain from Vercel" | T2 | one-liner | — | Error-magnet |
| R016 | 41 | "All URLs, tokens, and slugs must be in English" | T2 | one-liner | — | Error-magnet |

### Section 4 — Session Start (lines 43–56)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R017 | 44–56 | 3-step session start protocol with 2 SQL queries inline | T1 | preserve ENTIRE block (per decision A) | — | Runs every session start |

Note: Decision A locks SQL inline. Preserve exact column lists, filters, ORDER BY, LIMIT from lines 47–49.

### Section 5 — MCP Tools (lines 58–75)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R018 | 61 | "NEVER use execute_sql for CRM writes" | T2 | one-liner | `{tool:crm_update_record}` | Error-magnet |
| R019 | 62 | "Tool descriptions are the documentation" | T3-DEV | move | — | DEV reference |
| R020 | 63 | "Server instructions in lib/mcp/instructions.ts" | T3-DEV | move | — | DEV reference |
| R021 | 64 | "Mirror docs in docs/claude-connector-system-instructions.md" | T3-DEV | move | — | DEV reference |
| R022 | 66–75 | Full MCP Tool Counting block with grep command | T3-DEV | move | — | Procedural reference |

### Section 6 — Database (lines 77–80)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R023 | 78 | "Schema changes via Supabase Dashboard or execute_sql" | T3-DEV | move | — | Procedural |
| R024 | 79 | "RLS enabled on all tables" | T3-DEV | move | — | Reference |
| R025 | 80 | "Enums defined in DB — check before adding" | T3-DEV | move | — | Procedural |

### Section 7 — Invoice Architecture (lines 82–87)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R026 | 83 | "payments = TD receivables" | T3-ARCH | move | — | Reference |
| R027 | 84 | "client_invoices = Client sales ONLY. TD systems NEVER write here." | T2 | one-liner | `{table:client_invoices}` `{file:lib/portal/unified-invoice.ts}` | **Highest-value error-magnet** |
| R028 | 85 | "client_expenses = Client expenses" | T3-ARCH | move | — | Reference |
| R029 | 86 | "td_expenses = TD operating expenses" | T3-ARCH | move | — | Reference |
| R030 | 87 | Supporting table list | T3-ARCH | move | — | Reference |

### Section 8 — Auth / Google APIs / QuickBooks (lines 89–102)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R031 | 90–92 | Auth architecture | T3-ARCH | move | — | Reference |
| R032 | 95–98 | Google APIs (SA+DWD, impersonation, drive_upload variants) | T3-DEV | move | — | DEV reference |
| R033 | 101–102 | QuickBooks tokens + realm | T3-ARCH | move | — | Reference |

### Section 9 — Forms (lines 104–117)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R034 | 105–110 | Form pattern + admin preview mechanics | T3-DEV | move | — | DEV reference |
| R035 | 111 | "MANDATORY: never send form to client without ?preview=td test" | T2 | one-liner | — | Error-magnet |
| R036 | 112–117 | ?preview=td bypass code pattern | T3-DEV | move | — | DEV reference |

### Section 10 — safeSend (lines 119–142)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R037 | 119–125 | "MUST use safeSend... 1. Idempotency 2. Send FIRST 3. Status AFTER 4. Multi-step" | T2 | one-liner | `{file:lib/mcp/safe-send.ts}` | Error-magnet |
| R038 | 126 | "NEVER update status to 'sent' before actual send" | CONSOLIDATE->R037 | merge | — | Same rule, different framing |
| R039 | 129–140 | safeSend code example | T3-DEV | move | — | Pattern reference |
| R040 | 142 | "Tools using this: lease_send, offer_send" | T3-DEV | move | — | DEV reference |

### Section 11 — RFC 2047 (lines 144–161)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R041 | 144–146 | "Email subject MUST be RFC 2047 base64 encoded" | T2 | one-liner | — | Error-magnet |
| R042 | 148–159 | Code pattern (correct vs wrong) | T3-DEV | move | — | Pattern reference |
| R043 | 161 | "Applies to ALL email senders" | CONSOLIDATE->R041 | merge | — | Same rule |

### Section 12 — Anti-Compaction (lines 163–231)

Per decision B — tight compression, no expansion.

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R044 | 165–168 | "Why this exists" prose | DELETE as standalone, EMBED stakes in R047 | delete | — | Stakes framing moves into R047's verbose form |
| R045 | 170–175 | 4 hooks automatic protection list | T3-OPS | move | — | Hook inventory reference |
| R046 | 177–194 | "How to save" — 2 methods with SQL examples | T3-OPS | move | — | Procedural reference |
| R047 | 196–206 | **Core save rule + what-to-save list** | T1 | preserve verbose with inline 5-item checklist + stakes from R044 | — | **The behavioral rule** — per decision B, keep tight |
| R048 | 201–206 | What-to-save checklist | MERGED into R047 | merge | — | Becomes inline part of R047 |
| R049 | 208–213 | Recovery after compaction procedure | T3-OPS | move | — | Procedural reference |
| R050 | 215–216 | "Ops work uses sysdoc_create with slug ops-YYYY-MM-DD-topic" | T3-OPS | move | — | Procedural reference |
| R051 | 218–220 | "Subagents write results to Supabase BEFORE returning" | T2 | one-liner | — | Distinct rule |
| R052 | 222–228 | Key tables for dev context list | T3-OPS | move | — | Reference list |
| R053 | 224 | "RULE: Before INSERT on dev_tasks, SELECT first to dedupe" | T2 | one-liner | `{table:dev_tasks}` | Error-magnet |
| R054 | 230–231 | "Claude.ai equivalent — lib/mcp/reminder.ts middleware" | T3-OPS | move | — | Reference |

**Section 12 T1+T2 budget:** R047 verbose (~10 lines) + R051 (1 line) + R053 (1 line) = ~12 lines total.

### Section 13 — Verify Before Claiming (lines 233–240)

Per decision C — keep distinct, under unified heading.

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R055 | 233–240 | 4-step verify-before-claiming + "applies to EVERY conversation" + "wrong claim = failure" | T1 | preserve verbose with stakes, under "Verification Protocol" heading | — | Highest-priority behavioral rule |

### Section 14 — Verify Before Acting (lines 242–249)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R056 | 242–249 | 4-step verify-before-acting + "every question that could be a query = failure" | T1 | preserve verbose with stakes, under "Verification Protocol" heading | — | Distinct trigger from R055 |

### Section 15 — Check Before Acting (lines 251–257)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R057 | 251–257 | 3-step duplicate-action check (CRM tasks / Gmail sent / session_checkpoints) | T1 | preserve, under "Verification Protocol" heading | — | Distinct trigger from R055/R056 |

### Section 16 — CRM Update Rule (lines 259–266)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R058 | 259–266 | "Every client-facing action MUST be followed by IMMEDIATE CRM update" + 3-part checklist | T1 | preserve verbose | — | Behavioral |

### Section 17 — Business Rules (lines 268–272)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R059 | 269–271 | "Business rules live in knowledge_articles and sop_runbooks" | T3-OPS | move | — | Reference pointer |
| R060 | 272 | "Master Rules KB (370347b6) is the CANONICAL source... wins on conflict" | T2 | one-liner | `{table:knowledge_articles}` | Conflict-resolution meta-rule |

### Section 18 — Decision Propagation (lines 274–282)

Per decision D — replace unconditional 6-target with 3-category type-aware model.

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R061 | 274–282 | Current unconditional 6-target rule | T1 | **REPLACE** with 3-category type-aware rule from decision D | — | Usable under pressure |

**Replacement text for R061 in T1** (use the exact format from decision D above — Behavior / Business+SOP / System+Infra categories with target mappings).

### Section 19 — File Structure (lines 284–308)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R062 | 284–308 | File tree | T3-ARCH | move + update stale "15 tool files" count | — | Reference |

### Section 20 — Code Quality Pipeline (lines 310–345)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R063 | 315–319 | pre-commit lint-staged behavior | T3-QA | move | — | Reference |
| R064 | 321–326 | pre-push 5-step sequence | T3-QA | move | — | Reference |
| R065 | 328–331 | npm commands list | T3-QA | move | — | Reference |
| R066 | 333–336 | ESLint rule list | T3-QA | move | — | Reference |
| R067 | 338 | "RULE: Fix ESLint warnings in files you modify" | T2 | one-liner | — | Error-magnet |
| R068 | 340–345 | Sentry monitoring details | T3-ARCH | move | — | Reference |

### Section 21 — Communication (lines 347–348)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R069 | 348 | "Always communicate in English. Be direct and efficient." | T1 | preserve | — | Behavioral every turn |

### Section 22 — Multi-Machine Git Safety (lines 350–406)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R070 | 353–358 | "CRITICAL RULE #0: git pull before any work" | T2 | one-liner | — | Error-magnet, hook-enforced |
| R071 | 360–367 | "CRITICAL RULE #1: Never git add -A / git add ." | T2 | one-liner | — | Error-magnet |
| R072 | 369–374 | "Before committing, always" 5-step checklist | T3-GIT | move | — | Procedural reference |
| R073 | 376 | "Never commit files you didn't intentionally modify" | CONSOLIDATE->R071 | merge | — | Restatement |
| R074 | 378–385 | Protected files list | T3-GIT | move | — | Reference |
| R075 | 387–393 | "When git push fails" procedure | T3-GIT | move | — | Procedural reference |
| R076 | 393 | "NEVER run git push --force" | T2 | one-liner | — | Error-magnet |
| R077 | 395–401 | "Simultaneous work on multiple machines" | T3-GIT | move | — | Procedural reference |
| R078 | 403–406 | "Module-Level Initialization" (misplaced in git section) | T3-DEV | **move to T3-DEV, not T3-GIT** | — | Correcting misplacement in source |

### Section 23 — Mandatory QA Testing (lines 408–454)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R079 | 410–417 | "Every UI feature MUST be browser-tested before done" + 6-step checklist | T2 | one-liner | — | Error-magnet |
| R080 | 419–425 | "What counts as tested" checklist | T3-QA | move | — | Reference |
| R081 | 427–430 | "When to test" list | T3-QA | move | — | Reference |
| R082 | 432–444 | QA Test Accounts (admin + client credentials) | T3-QA with SPLIT | **SPLIT per decision E** | — | Admin moves to gitignored; client stays (AFTER qa-staff verification) |
| R083 | 446–449 | Test data conventions (Uxio Test LLC, QA Test prefix) | T3-QA | move | — | Reference |
| R084 | 451–454 | Chrome-not-available fallback | T3-QA | move | — | Reference |

### Section 24 — Mandatory Testing (lines 456–473)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R085 | 458–459 | "Every change MUST pass unit tests + build before push" | T3-QA | move | — | Reference (hook-enforced) |
| R086 | 461–465 | "Write unit tests for every new function" | T2 | one-liner | — | Error-magnet |
| R087 | 467–468 | "Run npm run test:unit after every code change" | T1 | preserve | — | Behavioral after code changes |
| R088 | 470–473 | npm test command list | T3-QA | move | — | Reference |

### Section 25 — Do NOT (lines 475–482)

| ID | Line | Original (excerpt) | Tier | Action | Anchor | Justification |
|---|---|---|---|---|---|---|
| R089 | 476 | "Use Make, Zapier, n8n" | T2 | one-liner | — | Technology choice rule |
| R090 | 477 | "Commit .env.local or credentials" | T2 | one-liner | — | Error-magnet |
| R091 | 478 | "Create README.md or docs unless asked" | T2 | one-liner | — | Output discipline |
| R092 | 479 | "Push to main without building first" | CONSOLIDATE->R064 | merge | — | Duplicate of pre-push rule |
| R093 | 480 | "Use git add -A or git add ." | CONSOLIDATE->R071 | merge | — | Duplicate of R071 |
| R094 | 481 | "Declare feature done without test:unit" | CONSOLIDATE->R087 | merge | — | Duplicate of R087 |
| R095 | 482 | "Push code without unit tests for new functions" | CONSOLIDATE->R086 | merge | — | Duplicate of R086 |

---

## TIER STATISTICS (post-migration target)

| Tier | Rule count | Line budget |
|---|---|---|
| **T1 — per-turn behavioral** | ~14 rules | ~100–120 lines |
| **T2 — error-magnet one-liners** | ~22 rules | ~35–50 lines |
| **T3-ARCH** | ~10 entries | Unbounded |
| **T3-DEV** | ~11 entries | Unbounded |
| **T3-QA** | ~10 entries | Unbounded |
| **T3-GIT** | ~5 entries | Unbounded |
| **T3-OPS** | ~8 entries | Unbounded |
| **CONSOLIDATE (dedupes)** | 7 | — |
| **DELETE** | 1 (R044 as standalone — content moves into R047) | — |

**Total original extracted rules:** 95
**Total T1+T2 after migration:** ~36 rules

---

## TRACE CHECK PROCEDURE (run after writing the draft)

For each row in this audit table where Action ∉ {DELETE, CONSOLIDATE}:

1. Pick 2–3 distinctive keywords from the original text (not generic words like "rule" or "always").
2. Grep the new `CLAUDE.md` draft for each keyword.
3. Mark PASS if all keywords found in the correct tier, FAIL otherwise.
4. For CONSOLIDATE rows: grep for the target rule's keywords instead.
5. For DELETE rows: confirm the text is NOT in the new file (that's the expected state).

**Output format:**
```
Trace Check Results — 2026-04-09
Total rows: 95
Pass: X
Fail: Y
Consolidated: 7
Deleted: 1

FAILURES:
- R0XX: keyword "Y" not found in T1 (expected in T1 per audit table)
  Action needed: locate and fix before DP1.3
```

Any FAILs block DP1.3 presentation. Fix first, re-run trace check, then present.

---

## NEXT SESSION — EXACT STARTING STEPS

1. Start new Claude Code session.
2. SessionStart hook runs git pull + session-start prompt.
3. Run session-start protocol:
   - `sysdoc_read('session-context')` — see the 18:11 checkpoint from 2026-04-09.
   - Query `dev_tasks` pending + done.
   - `git status` + recent commits.
4. Read this file: `/tmp/claude-md-audit-table-2026-04-09.md` (you are reading it now if resuming).
5. Re-read current `CLAUDE.md` in full, in-turn.
6. Verify `qa-staff@tonydurante.us` privileges via Supabase query.
7. Create branch `claude-md-migration-2026-04-09`.
8. Draft new `CLAUDE.md` following the audit table and locked decisions exactly.
9. Run trace check.
10. Present full diff + trace check results to user for DP1.3 approval.
11. On approval: commit draft to branch, merge to main.
12. On approval: commit this audit table file to `docs/claude-md-migration-2026-04-09.md` as permanent artifact.
13. Verify new CLAUDE.md loads in a fresh Claude Code session.

---

## END OF HANDOFF FILE
