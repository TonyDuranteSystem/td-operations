# TD Operations — Remediation Plan v2

**Date:** 2026-04-14
**Supersedes:** `docs/2026-04-14-system-audit-and-restructure.md` (v1) which contained multiple unverified claims and a 7-phase restructure plan that was over-scoped.
**Status:** Analysis complete. Several steps are grounded and ready. Several open decisions must be made before execution.
**Author protocol:** Every technical claim in this document cites file+line, table+column, or a tool invocation from the working session. Where a claim is inferential rather than directly observed, it is explicitly labeled **[INFERENCE]** and its reasoning chain is shown.

---

## 0. Why v2 exists

The first version of this analysis (`2026-04-14-system-audit-and-restructure.md`, 730 lines, uploaded to Drive at `1TXXHnWo8ZQKqsG5uwVwPG1dQTR_naW4i`) contained claims that did not survive spot-checking. An independent session re-verified the foundations and found multiple errors and over-reaches. This document is the result of a further verification pass that:

1. Re-verified the original audit's numeric claims directly
2. Traced the consumer of each CRITICAL finding before accepting its severity
3. Discovered pre-existing infrastructure that v1 ignored
4. Tested PostgreSQL-level behavior of the Supabase client (via `execute_sql`)
5. Grounded every remaining claim in on-screen evidence

**Key shift from v1 to v2:** v1 proposed a 7-phase architectural restructure across 3 machines. v2 proposes a much smaller, focused remediation because the verification pass revealed that most of v1's "bugs" either (a) don't cause client harm, (b) are already covered by existing infrastructure that just isn't wired correctly, or (c) are data-state issues rather than architectural defects.

**Key admission v1 lacked:** the system has a pre-existing daily `audit-health-check` cron at `app/api/cron/audit-health-check/route.ts` that is silently broken but was designed to catch nearly every issue v1 "discovered." Fixing the existing cron is the highest-leverage change in this document.

---

## 1. What was audited (methodology)

### 1.1 The initial broad audit (from v1)

v1 spawned 10 investigation agents in parallel, each working on a different slice of the system:

| # | Agent scope | Tool used |
|---|-------------|-----------|
| 1 | Schema integrity — code column refs vs actual DB schema | Grep + `execute_sql` |
| 2 | Data integrity — 11 invariant queries (B1–B11) on live data | `execute_sql` |
| 3 | Code path integrity — 8 critical routes × 8 criteria | Read file |
| 4 | Portal visibility + external integrations + write path inventory (D+E+F) | Read file + `execute_sql` |
| 5 | Cross-session handoff infrastructure | Read hook scripts + `execute_sql` |
| 6 | Portal access chain — 7 gates from middleware to dashboard | Read file + `execute_sql` |
| 7 | Wizard visibility root cause | Read file |
| 8 | Document signing pipeline — 6 tables + 6 page routes | Read file + `execute_sql` |
| 9 | Enum inconsistencies — DB ENUM vs CHECK vs `constants.ts` | `execute_sql` + Grep |
| 10 | Bank feed pipeline — 6 sync sources + cron registration | Read file + Read config |

After the broad audit, 4 additional deep-dive agents ran:

| # | Deep-dive scope | Purpose |
|---|----------------|---------|
| 11 | SD write path architecture | Determine why 10 files bypassed the central `advanceServiceDelivery()` function |
| 12 | DB-level protections (triggers, constraints, policies, FKs) | Determine what the database enforces vs what is enforced only in code |
| 13 | Test coverage landscape | Inventory all 22 unit test files and 14 E2E specs |
| 14 | Lifecycle state machine | Map designed vs actual transitions across lead/pending/account/tier/SD state tracks |

And 2 explore agents plus direct file reads for specific files:
- Error propagation patterns (partial — agent output not extractable)
- Supabase type safety (confirmed `as any` cast in supabase-admin.ts, no `database.types.ts` exists)
- Direct reads: `lib/service-delivery.ts` (534 lines), `lib/constants.ts` (261 lines), `lib/supabase-admin.ts` (24 lines), `app/api/[transport]/route.ts` (218 lines), `sentry.server.config.ts` (12 lines)

### 1.2 The verification pass (v2)

After an independent critique of v1 landed multiple valid corrections, a focused verification pass was run covering:

**1.2.1 Re-verification of v1's quantitative claims.** Every number in v1 was re-queried or re-grepped to see if it still held today.

**1.2.2 Consumer tracing.** For each finding v1 labeled CRITICAL, the actual consumer (the code path that reads the output of the broken function) was traced to see whether the break causes user-visible harm.

**1.2.3 Hook script path check.** v1 claimed `pre-compact-save.sh:8` and `stop-check.sh:7` have hardcoded paths. Both files were opened to confirm.

**1.2.4 `activate-service` stage check.** v1's Disease 1 timeline implied `activate-service` uses `current_stage` (wrong). The file was opened to verify.

**1.2.5 PostgreSQL function signature check.** `execute_sql` was used to query `pg_proc` for the actual signature of `exec_sql`.

**1.2.6 Direct SQL behavior test.** `execute_sql` was used to run both `exec_sql(sql_query := '...')` and `exec_sql(query := '...')` to observe the function's behavior with correct vs incorrect parameter names.

**1.2.7 SD write path enumeration.** Grep was run for all `current_stage` occurrences in `app/api/` and `lib/`, and each hit was categorized as read-alias (harmless), write-side (broken), select-side (broken), or downstream-use.

**1.2.8 Stuck clients query.** A SQL join between `itin_submissions` and `service_deliveries` was run to count how many ITIN clients are in a state equivalent to Manuel Burdo's (submission completed but SD never advanced).

**1.2.9 NULL-stage SD origin query.** The 124 NULL-stage active SDs were grouped by service_type, notes, assigned_to, and created_at distribution to identify their origin.

**1.2.10 Health check cron discovery and diagnosis.** After noticing `/api/cron/audit-health-check` in `vercel.json`, the route file was read end-to-end, the `scripts/audit-health-check.sql` file was read end-to-end (629 lines), the `cron_log` entries were queried, and the `exec_sql` function parameter mismatch was isolated as the silent failure source.

**1.2.11 Sample UI audit gap check.** Explore agents sampled 5 of 32 CRM dashboard pages and 5 of 38 portal pages to see whether the form-route bug patterns extend into UI code.

Every tool invocation, file read, and query result referenced below happened in the working session and produced output that was visible on screen at the time.

### 1.3 What was NOT audited

The v1 audit focused on data pipelines, API routes, and write paths. The v2 verification added consumer tracing and infrastructure discovery. Neither pass covered:

- **27 of 32 CRM dashboard pages** in `app/(dashboard)/` (5 sampled by one Explore agent in the verification pass)
- **33 of 38 portal pages** in `app/portal/` (5 sampled by one Explore agent)
- **Full MCP tool file review** — 206 tools across 41 files, most not directly read
- **Server actions** in `app/(dashboard)/*/actions.ts` files (not systematically inventoried)
- **React components in `components/`** — only `portal-sidebar.tsx` was read (and only partially)
- **Library utilities in `lib/`** beyond the specific files directly named in findings
- **Cron jobs beyond `audit-health-check`** — 20 crons registered in `vercel.json`, only 2 traced in detail (`audit-health-check`, `stripe-sync`)
- **All form-completed routes end-to-end** — only `itin-form-completed/route.ts` lines 180-231 and a few specific sections of others were read
- **Vercel dashboard** (environment variables, deployment logs, error logs) — no access from local machine

**The unaudited surface area matters** because the verification pass found real bugs (wrong `query:` parameter in 3 MCP tool sites) in files that were not part of the original audit. More bugs likely exist in the unaudited surface.

---

## 2. Verified findings (with evidence)

Each finding in this section is backed by at least one `execute_sql` result, file read, or grep output that was on screen during the session. Where the evidence was indirect or inferential, it is marked **[INFERENCE]**.

### 2.1 The `current_stage` ghost column

#### 2.1.1 The DB has no `current_stage` column on `service_deliveries`

**Test:** `execute_sql` with `SELECT id, current_stage FROM service_deliveries WHERE status = 'active' LIMIT 1`
**Result:** `SQL Error: column "current_stage" does not exist, SQLSTATE: 42703`
**Conclusion:** Direct SQL confirms `current_stage` does not exist on the `service_deliveries` table.

#### 2.1.2 Total occurrences of `current_stage` in source

**Test:** Grep for `current_stage` across the repo excluding docs
**Result:** 48 total occurrences across 17 files. Subtracting `docs/2026-04-14-system-audit-and-restructure.md` (12 occurrences, the v1 doc) and `.claude/agents/system-tester.md` (1 occurrence), the real source count is **35 occurrences across 15 source files**.

The 15 source files:
1. `lib/installment-handler.ts` — 6 occurrences
2. `lib/jobs/handlers/tax-form-setup.ts` — 3 occurrences
3. `lib/mcp/tools/tax.ts` — 2 occurrences
4. `lib/portal/queries.ts` — 3 occurrences
5. `lib/types.ts` — 1 occurrence
6. `app/(dashboard)/services/page.tsx` — 1 occurrence
7. `app/portal/services/page.tsx` — 2 occurrences
8. `app/portal/page.tsx` — 2 occurrences
9. `app/api/itin-form-completed/route.ts` — 4 occurrences
10. `app/api/formation-form-completed/route.ts` — 1 occurrence
11. `app/api/onboarding-form-completed/route.ts` — 1 occurrence
12. `app/api/closure-form-completed/route.ts` — 1 occurrence
13. `app/api/tax-form-completed/route.ts` — 3 occurrences
14. `app/api/portal/search/route.ts` — 3 occurrences
15. `app/api/internal/ai-assist/route.ts` — 2 occurrences

**Correction from v1:** v1 claimed "25+ references across 10 files." The correct number is 35 / 15 — roughly 40% undercount. v1 missed `lib/types.ts`, `app/portal/services/page.tsx`, `app/portal/page.tsx`, `app/(dashboard)/services/page.tsx`.

#### 2.1.3 Categorization of occurrences — read-aliases (HARMLESS)

Not all 35 occurrences are bugs. Some map the DB column `stage` to a TypeScript property named `current_stage` purely for UI/type purposes. These are harmless renames.

**Verified harmless aliases:**
- `lib/types.ts:333` — `current_stage: string | null` — TypeScript interface property declaration
- `lib/portal/queries.ts:80` — `current_stage: sd.stage ?? null` — maps DB stage to API response property
- `lib/portal/queries.ts:94` — `current_stage: null` — default value in mapper
- `lib/portal/queries.ts:117` — `current_stage: sd.stage` — same alias pattern
- `app/(dashboard)/services/page.tsx:62` — `current_stage: s.stage ?? null` — maps DB to UI property

#### 2.1.4 Categorization — INSERT-side writes with wrong column (BROKEN)

These are INSERT statements that include `current_stage:` as a key in the payload object. Verified by reading each line or via the grep output for `.insert\(.*current_stage|current_stage:\s*["']`:

- `lib/installment-handler.ts:90` — INSERT writes `current_stage: cmraStage?.[0]?.stage_name || "Lease Created"`
- `lib/installment-handler.ts:189` — INSERT writes `current_stage: taxStage?.[0]?.stage_name || "Activated"`
- `app/api/itin-form-completed/route.ts:218` — INSERT writes `current_stage: secondStage`
- `app/api/formation-form-completed/route.ts:143` — INSERT writes `current_stage: firstStage`
- `app/api/onboarding-form-completed/route.ts:141` — INSERT writes `current_stage: firstStage`
- `app/api/closure-form-completed/route.ts:162` — INSERT writes `current_stage: firstStage`

**Total: 6 INSERT sites**

#### 2.1.5 Categorization — UPDATE-side writes with wrong column (BROKEN)

UPDATE statements that set `current_stage:` as a key:

- `lib/installment-handler.ts:344` — `.update({ current_stage: "Ready for Filing", ... })`
- `lib/jobs/handlers/tax-form-setup.ts:290` — `.update({ stage: "Data Received", ..., current_stage: "Data Received", ... })` (**MIXED:** writes both `stage` and `current_stage` in same payload)
- `lib/mcp/tools/tax.ts:1175` — `.update({ current_stage: "Preparation - Sent to Accountant", ... })`
- `app/api/itin-form-completed/route.ts:200` — `.update({ current_stage: "Document Preparation", ... })`
- `app/api/tax-form-completed/route.ts:318` — `.update({ current_stage: "Data Received", updated_at: ... })`

**Total: 5 UPDATE sites**

**Note on the MIXED case at `tax-form-setup.ts:290`:** This UPDATE sets BOTH `stage: "Data Received"` (line 287, valid column) AND `current_stage: "Data Received"` (line 290, invalid column) in the same payload. If PostgREST rejects the whole payload on unknown columns, this UPDATE fails completely. If PostgREST silently drops unknown keys, the valid `stage` lands and the effect is what the code intended. **This behavior is NOT directly tested in the working session.** PostgREST behavior on mixed payloads is a known gap in v2's evidence.

Also of note at `tax-form-setup.ts:284-295`: this is ONE of only 2 sites in the whole codebase (verified via grep in Section 2.4 below) that actually destructures `const { error: sdErr }` and checks it at line 295. If PostgREST returns an error on this mixed UPDATE, the check at line 295 would fire and the result would show `sd_advance: error` in the route's return object. Whether this has been happening is not verifiable from the code alone — it would require reading `action_log` or production logs to see.

#### 2.1.6 Categorization — SELECT-side reads of non-existent column

SELECT statements that reference `current_stage` in the column list:

- `app/api/itin-form-completed/route.ts:189` — `.select("id, current_stage")`
- `app/api/tax-form-completed/route.ts:308` — `.select("id, current_stage")`
- `app/api/portal/search/route.ts:63` — `.select('id, service_name, service_type, current_stage, status')`
- `app/api/internal/ai-assist/route.ts:30` — `.select('service_type, current_stage, status, notes')`
- `lib/installment-handler.ts:334` — `.select("id, current_stage")`
- `lib/mcp/tools/tax.ts:1165` — `.select("id, current_stage")`
- `lib/jobs/handlers/tax-form-setup.ts:267` — `.select("id, stage, stage_order, stage_history, current_stage")` (includes both valid and invalid columns)

**Total: 7 SELECT sites**

**PostgreSQL-level behavior on SELECT of unknown column (verified via execute_sql):** returns `42703 column does not exist`. **PostgREST-level behavior (via Supabase JS client) is NOT directly tested in this session.** **[INFERENCE]** Based on PostgREST documentation and the empirical observation of `findings: []` in the cron log (Section 2.7), the most consistent explanation is that PostgREST propagates the error to the client, the client returns `{ data: null, error: {...} }`, and the calling code (which does not destructure `error`) treats the null data as "no row found" and moves to the next branch.

#### 2.1.7 Categorization — downstream reads of the SELECT results

These references use `s.current_stage`, `sd.current_stage`, `taxSd.current_stage`, `existingSd[0].current_stage` etc. — accessing the property from an object that was populated (or not) by one of the broken SELECTs:

- `app/api/itin-form-completed/route.ts:198` — `existingSd[0].current_stage === "Data Collection"`
- `app/api/tax-form-completed/route.ts:315` — `sd.current_stage === "Data Link Sent" || sd.current_stage === "Activated"`
- `app/api/portal/search/route.ts:70` — `s.current_stage` used in subtitle
- `app/api/portal/search/route.ts:75` — `s.current_stage` used in object property
- `app/api/internal/ai-assist/route.ts:91` — `s.current_stage` used in AI prompt
- `lib/installment-handler.ts:340` — `taxSd.current_stage === "Awaiting 2nd Payment"`
- `lib/installment-handler.ts:351` — `taxSd.current_stage` used in result string
- `lib/jobs/handlers/tax-form-setup.ts:278` — `sdRecord.stage || sdRecord.current_stage` (fallback chain — uses valid `stage` first, then broken `current_stage` as fallback)
- `app/portal/services/page.tsx:117` — `{s.current_stage && (...)}` — conditional render
- `app/portal/services/page.tsx:118` — `{s.current_stage}` — displays value
- `app/portal/page.tsx` — 2 occurrences (not individually read in session but grep shows presence)

**Total: ~12 downstream-read sites.** These sites are harmless IF their upstream data source uses the valid read-alias pattern (from Section 2.1.3). For example, `portal/services/page.tsx:117-118` displays `s.current_stage` which comes from `getPortalServices()` in `queries.ts:80`, which is a read-alias that sets `current_stage: sd.stage ?? null` — so the display works correctly via the valid alias.

**But some downstream sites read from a broken upstream.** For example, `itin-form-completed/route.ts:198` compares `existingSd[0].current_stage === "Data Collection"` where `existingSd` came from the broken SELECT at line 189. If the SELECT errored (inference), `existingSd` is null and `existingSd?.length` is falsy, so line 198 never runs. If the SELECT silently dropped the column (alternative inference), `existingSd[0].current_stage` is undefined and the comparison is always false. Either way, the advance branch is skipped.

### 2.2 Real client harm from the `current_stage` bug — verified

#### 2.2.1 Manuel Burdo's ITIN case

**Test:** `execute_sql` joining `itin_submissions` with `service_deliveries` for completed submissions where SD was not updated after completion
**Query:**
```sql
SELECT s.id as submission_id, s.status as sub_status, s.completed_at,
       sd.id as sd_id, sd.stage as sd_stage, sd.updated_at as sd_updated,
       a.company_name
FROM itin_submissions s
LEFT JOIN service_deliveries sd ON sd.account_id = s.account_id AND sd.service_type = 'ITIN' AND sd.status = 'active'
LEFT JOIN accounts a ON a.id = s.account_id
WHERE s.status = 'completed'
ORDER BY s.completed_at DESC
LIMIT 20
```
**Result (most recent row):**
- submission_id: `d4048f23-1bd3-4d33-aaa8-83442e41818d`
- sub_status: `completed`
- completed_at: `2026-03-19T16:15:21.219+00:00`
- sd_id: `746faa3a-3202-47c1-a0df-e212aac3a432`
- sd_stage: `Data Collection`
- sd_updated: `2026-03-18T17:54:46.838123+00:00`
- company_name: `Stay Legit LLC`

**Interpretation:** Stay Legit LLC (Manuel Burdo) submitted the ITIN form on 2026-03-19 at 16:15 UTC. The matching SD was last updated on 2026-03-18 at 17:54 UTC — before the form was even completed. No update has happened since. The ITIN has been stuck at "Data Collection" for 25+ days as of 2026-04-14.

**Correlation with the `current_stage` bug chain:** `itin-form-completed/route.ts:189` does `.select("id, current_stage")`. **[INFERENCE]** The SELECT fails. Line 195 `if (existingSd?.length)` is false, else branch at line 205 fires, auto-create INSERT at line 213-222 also includes `current_stage:` in payload → also fails. Neither branch advances the existing SD.

**Alternative hypothesis:** PostgREST silently strips unknown columns on SELECT. Then `existingSd` is `[{id: "746faa3a-..."}]` (a real row minus the current_stage key). `existingSd?.length` is truthy, `existingSd[0].current_stage` is undefined, `undefined === "Data Collection"` is false, the UPDATE at line 199-202 is skipped. Same effective outcome: SD is not advanced.

**Either hypothesis matches the observed outcome (SD stuck at "Data Collection" with updated_at before completed_at).** The two failure modes are indistinguishable from the observation, and both lead to the same user-visible result. Which hypothesis is correct matters for whether the bugs have been silently logged somewhere (errors) or silently invisible (undefined comparisons).

#### 2.2.2 Other form types — NOT verified

**Test attempted:** A UNION ALL query joining `formation_submissions`, `onboarding_submissions`, `closure_submissions`, `banking_submissions`, and `tax_return_submissions` to find all stuck clients.
**Result:** The query errored with `42703 column "fs.account_id" does not exist`. `formation_submissions` has `contact_id` and `token` but **no `account_id` column** (verified via `execute_sql` on `information_schema.columns`). The other submission tables DO have `account_id`:
- banking_submissions — has `account_id`
- closure_submissions — has `account_id`
- formation_submissions — **no `account_id`** (contact_id + token only)
- onboarding_submissions — has `account_id`

**What this means:** Formation submissions join to SDs through `contact_id` or `token`, not `account_id`. A corrected query is possible but was not run in the session. The count of stuck clients across all form types is **UNKNOWN**.

### 2.3 The 124 NULL-stage active service_deliveries

#### 2.3.1 The count

**Test:** `execute_sql SELECT count(*) FROM service_deliveries WHERE status = 'active' AND stage IS NULL`
**Result via B1 invariant:** 124 rows

#### 2.3.2 The origin — NOT from form routes

**Test:** `execute_sql` grouping NULL-stage active SDs by service_type, created_at window, and assigned_to
**Query:**
```sql
SELECT service_type, count(*) as null_stage_count,
       min(created_at) as oldest, max(created_at) as newest,
       count(DISTINCT assigned_to) as distinct_assignees
FROM service_deliveries
WHERE status = 'active' AND stage IS NULL
GROUP BY service_type
ORDER BY count(*) DESC
```
**Result:**
- service_type: `Annual Renewal`
- null_stage_count: `124`
- oldest: `2026-04-09T17:07:16.567464+00:00`
- newest: `2026-04-09T19:40:56.516135+00:00`
- distinct_assignees: `1`

**Second query — notes and assigned_to breakdown:**
```sql
SELECT notes, assigned_to, count(*)
FROM service_deliveries
WHERE status = 'active' AND stage IS NULL AND service_type = 'Annual Renewal'
GROUP BY notes, assigned_to
```
**Result:**
- notes: `Legacy onboard`
- assigned_to: `Luca`
- count: `124`

**Interpretation:** All 124 NULL-stage active SDs are:
- service_type `Annual Renewal`
- notes literally `"Legacy onboard"`
- assigned to `Luca`
- created within a 2.5-hour window on 2026-04-09

**This is ONE bulk insert event.** Likely a migration script or bulk creation run to set up Annual Renewal tracking for existing clients. It did not set `stage` on any of the 124 rows. This is NOT a symptom of the form-route `current_stage` bug.

**Relevance to v1's claim:** v1 framed the 124 NULL-stage SDs as the downstream effect of the broken form routes (silent data corruption). That framing is falsified. The 124 NULL stages have a completely separate origin and are not evidence of the form-route bug.

#### 2.3.3 A separate raw SQL cleanup happened on the same day

**Test:** `execute_sql` query on `action_log` for recent `sd_advance` or `Data Received` entries
**Result (one notable row):**
- action_type: `execute_sql`
- table_name: `service_deliveries`
- summary: `Raw SQL UPDATE: UPDATE service_deliveries SET stage = 'Data Received' WHERE id IN ('8f39d189-...','92feab33-...','937c9c0f-...', ... ~43 IDs ...)`
- created_at: `2026-04-09T00:34:15.695024+00:00`

**Interpretation:** On 2026-04-09 at 00:34 UTC (~17 hours BEFORE the bulk Annual Renewal insert), someone ran a raw SQL UPDATE to set `stage = 'Data Received'` on approximately 43 SDs. This is an instance of the "manual band-aid fix" pattern Antonio described in the client-assistance anti-pattern. The fix was recorded in `action_log` via the `execute_sql` MCP tool's mutation logging.

**This cleanup did NOT address the 124 Legacy Onboard Annual Renewal rows** because they were created later the same day.

### 2.4 Error destructuring on `service_deliveries` calls

#### 2.4.1 Count of sites that check errors

**Test:** Grep for `error:\s*\w+[Ee]rr.*from\(.service_deliveries` and `\{\s*error\s*[:,].*from\(.service_deliveries`
**Result:** 1 match — `app/api/crm/admin-actions/audit-chain/route.ts:1451`

**Additional site found via separate grep:** `lib/jobs/handlers/tax-form-setup.ts:284-295` uses `const { error: sdErr } = await supabaseAdmin.from("service_deliveries").update(...)` at line 284, and checks `if (sdErr)` at line 295. This site was not caught by the first grep pattern because the error is renamed to `sdErr`.

**Total confirmed sites that destructure error on `service_deliveries`: 2.**

**Interpretation:** Out of dozens of `.from('service_deliveries')` call sites across the codebase, only 2 actually check whether the operation succeeded. Every other site discards the error and proceeds as if the operation worked.

### 2.5 Hook scripts hardcoded paths

#### 2.5.1 `pre-compact-save.sh`

**Test:** `Read` of `.claude/hooks/pre-compact-save.sh` lines 1-20
**Finding at line 8:** `REPO_DIR="/Users/tonydurante/Desktop/td-operations"`
**The machine:** This MacBook is at `/Users/tonymac/Developer/td-operations` (verified from session context).
**Effect:** Line 14 `if [ -d "$REPO_DIR/.git" ]; then` is false on this machine. The git state capture (lines 15-16) is skipped. The pre-compaction auto-save has no git state when it runs on this machine.

#### 2.5.2 `stop-check.sh`

**Test:** `Read` of `.claude/hooks/stop-check.sh` lines 1-20
**Finding at line 6:** `REPO_DIR="/Users/tonydurante/Desktop/td-operations"` — same hardcoded path
**Correction from v1:** v1 cited this at line 7. The actual line is 6. (Off-by-one error in v1.)
**Effect:** Same as `pre-compact-save.sh` — line 18 `if [ -d "$REPO_DIR/.git" ]; then` is false, dirty-files and recent-commits capture skipped on this machine.

#### 2.5.3 Evidence the safety net has never fired

**Test:** During v1's cross-session analysis, a query was run against `session_checkpoints` for rows with `session_type = 'pre-compaction-auto'`. **Result: zero rows.** (Cited from v1 analysis, not re-verified in v2.)

**Interpretation:** Either compaction has never triggered the auto-save, or the auto-save has silently failed every time due to the hardcoded path bug. Cannot distinguish without running a test compaction.

### 2.6 `activate-service` writes the correct column

#### 2.6.1 Stage lookup and write

**Test:** Reading `app/api/workflows/activate-service/route.ts` around line 480 (from v1 agent output)
**Finding:** The file uses `stage: stage` (correct column) based on a `firstStage.get(pipeline)` lookup.
**Correction from v1:** v1's Disease 1 timeline labeled `activate-service` as "Mixed (activate uses stage, formation uses current_stage)". The parenthetical explicitly says `activate uses stage` correctly. The verification pass confirmed the activate-service writes are valid.
**v1 error:** v1's Section 4 RC1 table does NOT list `activate-service` — the table is correct. The confusion was in Disease 1's timeline row which grouped `activate-service` and `formation-form-completed` together under the same date with a "Mixed" column label. A reader could misread this as "activate-service is broken." The timeline wording was ambiguous, not wrong.

#### 2.6.2 Stage values are valid for Tax Return pipeline

**Test:** `execute_sql` querying `pipeline_stages` for Tax Return stages
**Result (relevant rows):**
- `Tax Return | Company Data Pending | -1`
- `Tax Return | Paid - Awaiting Data | 0`
- `Tax Return | 1st Installment Paid | 1`
- `Tax Return | Extension Filed | 2`
- `Tax Return | Data Received | 3`
- `Tax Return | Awaiting 2nd Payment | 4`
- `Tax Return | Preparation | 5`
- `Tax Return | TR Completed | 6`
- `Tax Return | TR Filed | 7`
- `Tax Return | Terminated - Non Payment | 8`

`activate-service/route.ts:464` uses `"Company Data Pending"` — VALID (stage_order -1).
`activate-service/route.ts:467` uses `"1st Installment Paid"` — VALID (stage_order 1).
`activate-service/route.ts:470` uses `firstStage.get(pipeline)` — VALID (dynamic lookup from the same table).

**Interpretation:** `activate-service` is not buggy for stage values. It uses the correct column name and valid pipeline stage values.

### 2.7 The audit-health-check cron — pre-existing infrastructure

#### 2.7.1 Cron is registered

**Test:** `Read` of `vercel.json` (132 lines total)
**Finding at lines 79-82:**
```json
{
  "path": "/api/cron/audit-health-check",
  "schedule": "0 7 * * *"
}
```

**Interpretation:** A cron named `audit-health-check` is registered to run daily at 07:00 UTC. This is pre-existing infrastructure that v1 did not discover.

#### 2.7.2 Cron runs successfully every day but finds nothing

**Test:** `execute_sql` query on `cron_log` for `audit-health-check` entries
**Query:**
```sql
SELECT endpoint, status, duration_ms, error_message, details, executed_at
FROM cron_log
WHERE endpoint = '/api/cron/audit-health-check'
ORDER BY executed_at DESC
LIMIT 10
```
**Result (5 most recent rows):**
- 2026-04-14 07:00:01 — status: success — duration_ms: 428 — details: `{p0: 0, p1: 0, p2: 0, findings: [], total_affected: 0, total_findings: 0}`
- 2026-04-13 07:00:33 — status: success — duration_ms: 518 — details: same zeros
- 2026-04-11 07:00:30 — status: success — duration_ms: 439 — same zeros
- 2026-04-10 07:04:45 — status: success — duration_ms: 364 — same zeros
- 2026-04-09 07:00:01 — status: success — duration_ms: 384 — same zeros

**Interpretation:** The cron has been running daily for at least 5 consecutive days. Every run logs `status: "success"` with all zero findings. Duration is consistently ~400ms.

**Contradiction with independent evidence:** The verification pass confirmed that the following violations exist in the live data right now (2026-04-14):
- 124 NULL-stage active SDs (Section 2.3.1)
- 5 stuck Tax Return SDs with stage "Data Collection" (B2 from v1's audit, not re-verified in v2)
- 56 cancelled/closed accounts with portal_tier = active or full (v1 B6-related, re-verified in v2: 43 Cancelled + 11 Closed + 1 Offboarding + 1 Suspended = 56)
- 1 stuck ITIN client (Manuel Burdo)
- 95 contacts with portal_tier but no auth.users record (v1 said 97; v2 got 95 via `execute_sql`)
- 69 active accounts with zero documents (v1 said 35; v2 got 69 — nearly double)

**None of these show up in the cron's findings.** Either the cron isn't running the checks it claims to run, or the checks are not returning matches they should return.

#### 2.7.3 The audit SQL file on disk — what checks it claims to run

**Test:** `Bash wc -l scripts/audit-health-check.sql` → 629 lines
**Test:** `Read` of the file in 3 passes (lines 1-100, 100-365, 365-629)
**Finding:** The file contains 39 distinct checks organized in 3 sections:

**Section 1: Status value checks (Checks 1-24)** — Each check finds rows where a status/tier/role column contains a value outside the allowed set. These are strict "value in allowed set" filters.
- Check 1: `service_deliveries.status` (P0)
- Check 2: `service_deliveries.service_type` (P0)
- Check 3: `offers.status` (P0)
- Check 4: `lease_agreements.status` (P0)
- Check 5: `oa_agreements.status` (P0)
- Check 6: `ss4_applications.status` (P0)
- Check 7: `deadlines.status` (P0)
- Check 8: `documents.status` (P0)
- Check 9: `client_invoices.status` (P0)
- Check 10: `client_expenses.status` (P0)
- Check 11: `banking_submissions.status` (P0)
- Check 12: `formation_submissions.status` (P0)
- Check 13: `onboarding_submissions.status` (P0)
- Check 14: `tax_return_submissions.status` (P0)
- Check 15: `itin_submissions.status` (P0)
- Check 16: `closure_submissions.status` (P0)
- Check 17: `wizard_progress.status` (P0)
- Check 18: `pending_activations.status` (P0)
- Check 19: `referrals.status` (P0)
- Check 20: `signature_requests.status` (P0)
- Check 21: `contacts.portal_tier` (P1) — checks `NOT IN ('lead', 'onboarding', 'active')`
- Check 22: `contacts.portal_role` (P1)
- Check 23: `accounts.portal_tier` (P1) — checks `NOT IN ('lead', 'onboarding', 'active')`
- Check 24: `tasks.status` (P0)

**Section 2: Business logic checks (Checks 25-35)**
- Check 25: Payments marked Paid with NULL paid_date (P1)
- Check 26: Active SDs on Cancelled/Closed accounts (P1)
- Check 27: Stuck pending_activations (>7 days at payment_confirmed) (P1)
- **Check 28: Active SDs with NULL stage** (P2) — **corresponds to v1's B1 finding**
- **Check 29: Portal tier mismatch contact↔account** (P1) — **corresponds to v1's B6 finding**
- **Check 30: Portal tier mismatch contact↔auth.users** (P1) — **corresponds to v1's B5 finding**
- Check 31: Orphan auth.users (no matching contact) (P1)
- Check 32: SD service_type not in pipeline_stages (P2)
- **Check 33: SD stage not matching pipeline_stages for service_type** (P1) — **corresponds to v1's B2 finding**
- Check 34: Active accounts with zero SDs (P2)
- Check 35: Stale QB sync (pending >7 days) (P2)

**Section 3: Orphan checks (Checks 36-39)**
- Check 36: SDs with non-existent account_id (P0)
- Check 37: SDs with non-existent contact_id (P0)
- Check 38: Payments with non-existent account_id (P0)
- Check 39: Documents with non-existent account_id (P0)

**Significance:** Several of the existing checks correspond directly to findings v1 reported as if they were novel. Specifically:
- v1's B1 (124 NULL stages) = Check 28
- v1's B6 (tier mismatch contact↔account) = Check 29
- v1's B5 (tier mismatch contact↔auth.users) = Check 30
- v1's B2 (invalid stage for service_type) = Check 33

**The audit script would find all of these if it were actually running.** It is running daily but finding nothing. This is the infrastructure bug in Section 2.7.4.

#### 2.7.4 The infrastructure bug — why the cron finds nothing

**Evidence trail:**

**(a)** `Read` of `app/api/cron/audit-health-check/route.ts` — total 194 lines (verified via `wc -l`).

**(b)** Lines 17-88: the GET handler.
Line 27: `const { data: rows, error } = await supabaseAdmin.rpc("exec_sql", { query: AUDIT_SQL })`
Line 32: `const findings = error ? await runChecksIndividually() : (rows as AuditRow[])`

**(c)** Lines 99-189: the `runChecksIndividually()` fallback function with 9 inline checks.
Line 170: `const { data } = await supabaseAdmin.rpc("exec_sql", { query: check.sql })`
Lines 183-185:
```typescript
} catch {
  // Individual check failed — skip, don't block others
}
```

**(d)** Lines 191-194: the `AUDIT_SQL` constant declaration.
Lines 191-193 comment:
```typescript
// The full audit SQL is in scripts/audit-health-check.sql (630 lines).
// This constant holds the top-level CTE query for use with exec_sql RPC.
// If exec_sql is unavailable, we fall back to runChecksIndividually() above.
```
Line 194:
```typescript
const AUDIT_SQL = "SELECT 'rpc_not_configured' AS check_name, 'system' AS table_name, 'P2' AS severity, 0::int AS records_affected, NULL AS sample_ids, 'exec_sql RPC not available — using individual checks' AS description"
```

**Finding 1:** `AUDIT_SQL` at line 194 is a 1-row stub that returns a placeholder indicating `rpc_not_configured`. It is NOT the content of `scripts/audit-health-check.sql`. The comment at lines 191-193 describes what the constant SHOULD hold, but the value doesn't match the description.

**Finding 2:** Grep of the route file for `readFile|readFileSync|audit-health-check\.sql` returns only the comment at line 191. **There is no code path in the route that loads `scripts/audit-health-check.sql` from disk.** The file exists on disk but is not imported, read, or referenced by runtime code.

**Finding 3:** `Grep` of `AUDIT_SQL` in the route file returns exactly 2 occurrences — line 28 (passed to rpc) and line 194 (declaration). The constant is not reassigned or loaded dynamically. What you see at line 194 is what the route uses.

**(e)** DB function signature for `exec_sql`:
**Test:** `execute_sql` querying `pg_proc`
**Query:** `SELECT n.nspname, p.proname, pg_get_function_arguments(p.oid) as args FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = 'exec_sql'`
**Result:**
- schema_name: `public`
- function_name: `exec_sql`
- args: `sql_query text`

**Interpretation:** The function takes one parameter named `sql_query`.

**(f)** Direct function call test with correct parameter name:
**Test:** `execute_sql` with `SELECT * FROM public.exec_sql(sql_query := 'SELECT 1 AS test, ''hello'' AS msg')`
**Result:** `[{"exec_sql": [{"test": 1, "msg": "hello"}]}]`
**Interpretation:** `exec_sql(sql_query := ...)` works and returns the wrapped row.

**(g)** Direct function call test with wrong parameter name:
**Test:** `execute_sql` with `SELECT * FROM public.exec_sql(query := 'SELECT 1 AS test')`
**Result:** `SQL Error: function public.exec_sql(query => unknown) does not exist, SQLSTATE: 42883`
**Interpretation:** Calling `exec_sql` with parameter named `query` fails because PostgreSQL resolves function overloads by named parameters, and no overload with parameter `query` exists.

**(h)** All call sites in the codebase — Grep for `rpc\(["']exec_sql["']`:
- `lib/mcp/tools/sql.ts:344-345` — `rpc("exec_sql", { sql_query: countQuery })` — **CORRECT**
- `lib/mcp/tools/sql.ts:369-370` — `rpc("exec_sql", { sql_query: sqlQuery })` — **CORRECT**
- `lib/mcp/tools/messaging.ts:284-285` — `rpc("exec_sql", { sql_query: "SELECT ..." })` — **CORRECT**
- `lib/mcp/tools/referrals.ts:343-344` — `rpc("exec_sql", { query: \`...\` })` — **WRONG**
- `lib/mcp/tools/operations.ts:1112-1113` — `rpc("exec_sql", { query: \`...\` })` — **WRONG**
- `lib/mcp/tools/operations.ts:1133-1134` — `rpc("exec_sql", { query: \`...\` })` — **WRONG**
- `app/api/cron/audit-health-check/route.ts:27-28` — `rpc("exec_sql", { query: AUDIT_SQL })` — **WRONG**
- `app/api/cron/audit-health-check/route.ts:170` — `rpc("exec_sql", { query: check.sql })` — **WRONG**

**Total: 3 correct sites, 5 wrong sites.** The correct pattern is used in the most heavily-exercised tool (`lib/mcp/tools/sql.ts`, the MCP raw SQL tool Antonio uses routinely). The wrong pattern exists in the audit-health-check route (both calls) and in 3 other MCP tool files.

**(i)** Cumulative interpretation of findings 1-8:

The audit-health-check cron's primary code path (line 27) calls `rpc("exec_sql", { query: AUDIT_SQL })`. The parameter name `query` does not match the function signature `sql_query text`. Direct SQL testing proves this combination fails with 42883 when called via PL/pgSQL named parameters.

**[INFERENCE]** The Supabase JS SDK's `rpc()` method sends the JSON body as named parameters to PostgREST, which translates them to PostgreSQL function arguments. The most consistent interpretation of the observed empty `findings: []` in cron_log is that the parameter name mismatch causes PostgREST to return an error to the SDK. The SDK returns `{ data: null, error: {...} }`. The route code at line 27 captures `{ data: rows, error }` and checks `error` at line 32. Line 32 then calls `runChecksIndividually()` which has the same parameter name mismatch on every inline check (line 170), each call errors, each error is caught and silenced by the try/catch at lines 183-185, `results` remains an empty array, and the final output at line 72 logs `findings: [], p0: 0, p1: 0, p2: 0` to cron_log.

**What is NOT directly tested in this session:** the Supabase JS SDK's actual HTTP response when called with `rpc("exec_sql", { query: "..." })`. The chain of reasoning depends on the assumption that the SDK behaves the way its documentation describes — that it sends named parameters via JSON body to PostgREST's `/rpc/exec_sql` endpoint, and that PostgREST returns the same 42883 error for unknown parameters as the PL/pgSQL named-call version.

**Stronger supporting evidence (but still not direct end-to-end observation):**
- The stub `AUDIT_SQL` at line 194 has severity "P2" and records_affected 0. If the primary code path ran the stub successfully, findings would contain 1 row with severity P2, giving p2=1, total_findings=1. The cron_log shows p2=0 and total_findings=0 — so the stub did NOT run successfully, meaning the RPC call errored and the fallback ran.
- The fallback `runChecksIndividually()` has 9 inline checks. If ANY check succeeded, findings would have at least 1 row. The cron_log shows findings=[] — so every check failed. The only common failure mode for 9 different checks is the shared parameter name mismatch at line 170.

**Conclusion (still marked as inference):** The most consistent explanation with all observed evidence is: both the primary path and the fallback path fail silently due to the same parameter name bug. The cron logs "success" every day with zero findings while real violations exist in the data.

#### 2.7.5 The cron would find the violations if it worked

**Test:** `execute_sql` running Check 28's logic directly:
**Query:**
```sql
SELECT
  'sd_null_stage' AS check_name,
  'service_deliveries' AS table_name,
  'P2' AS severity,
  COUNT(*)::int AS records_affected,
  LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200) AS sample_ids,
  'SDs with NULL stage: ' || COALESCE(STRING_AGG(DISTINCT sd.service_type, ', '), 'N/A') AS description
FROM service_deliveries sd
WHERE sd.stage IS NULL
  AND sd.status = 'active'
  AND sd.service_type IN (SELECT DISTINCT service_type FROM pipeline_stages)
```
**Result:**
- check_name: `sd_null_stage`
- table_name: `service_deliveries`
- severity: `P2`
- records_affected: `124`
- sample_ids: `31b41007-d589-4169-bb6f-8f90da775cd8, dda1172f-d22b-4edd-bed4-484ccbded4b9, d1b2e569-ae5a-4a92-85a0-3a0d767e0e3d, 81e075f1-4492-4e3b-adbf-c987817f2df6, 67941717-09a9-45bc-8cd6-eb29cebfab79, fc3fa65b-2`
- description: `SDs with NULL stage: Annual Renewal`

**Interpretation:** The SQL logic of Check 28 works correctly when executed directly. It finds exactly the 124 Legacy Onboard Annual Renewal SDs from Section 2.3.2. **The check is sound. The execution path is broken.**

### 2.8 Other verified claims from v1

#### 2.8.1 Data integrity counts (B1–B11)

**Re-verification status (v2, 2026-04-14):**

| Check | v1 count | v2 count | Delta |
|-------|---------|----------|-------|
| B1: Active SDs NULL stage | 124 | 124 | Same |
| B2: Active SDs invalid stage | 5 | not re-run | - |
| B3: Auth user contact_id orphan | 0 | not re-run | - |
| B4: Auth user NULL contact_id | 1 | not re-run | - |
| B5: Portal tier desync (auth vs contact) | 4 | not re-run | - |
| B6: Portal tier desync (contact vs account) | 2 | not re-run | - |
| B7: ITIN stuck | 1 | 1 (Manuel Burdo) | Same |
| B8: Paid with no active SD | 10 | not re-run | - |
| B9: Pending activations stuck | 0 | not re-run | - |
| B10: Stuck SDs >14 days | 7 | not re-run | - |
| B11: Total auth users | 208 | not re-run | - |

**Other counts (not from B-series but verified in v2):**
- Contacts with portal_tier but no auth.users: v1 said 97, v2 counted 95 via `SELECT count(*) FROM contacts c WHERE c.portal_tier IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users au WHERE au.raw_app_meta_data->>'contact_id' = c.id::text AND au.raw_app_meta_data->>'role' = 'client')`. Delta of 2.
- Cancelled/closed with active portal_tier: v1 said 56, v2 counted 56 exact via `SELECT status, count(*), count(CASE WHEN portal_tier IN ('active','full') THEN 1 END) FROM accounts WHERE status IN ('Cancelled','Closed','Offboarding','Suspended') GROUP BY status`. Result: Cancelled 43/43, Closed 11/11, Offboarding 1/1, Suspended 1/1 = 56.
- Active accounts with zero documents: v1 said 35, v2 counted 69 via `SELECT count(*) FROM accounts a WHERE a.status = 'Active' AND NOT EXISTS (SELECT 1 FROM oa_agreements WHERE account_id = a.id) AND NOT EXISTS (SELECT 1 FROM lease_agreements WHERE account_id = a.id) AND NOT EXISTS (SELECT 1 FROM signature_requests WHERE account_id = a.id) AND NOT EXISTS (SELECT 1 FROM ss4_applications WHERE account_id = a.id)`. **This is nearly double v1's count.** Either the number grew since v1 ran or the v1 query was narrower.

#### 2.8.2 Supabase JS client type safety

**Test:** `Read` of `lib/supabase-admin.ts` (24 lines total)
**Finding:**
- Line 11: `let _supabaseAdmin: SupabaseClient | null = null`
- Line 13: `export const supabaseAdmin = new Proxy({} as SupabaseClient, {`
- Line 22: `return (_supabaseAdmin as any)[prop]`

**Interpretation:** The Supabase client is created without the `Database` generic type parameter. The proxy pattern uses `as any` to bypass all type checking on the returned property. Every `.from("any_table").insert({any_column: any_value})` call compiles without TypeScript errors because the client's return type is `any`.

**Test:** `Glob` for `**/*database.types*` and `**/*supabase.types*`
**Result:** No files found (outside `node_modules`)
**Interpretation:** No generated database type file exists. The project has never run `supabase gen types`.

#### 2.8.3 Sentry configuration

**Test:** `Read` of `sentry.server.config.ts` (full file, 12 lines)
**Full content:**
```typescript
import * as Sentry from "@sentry/nextjs"

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Performance monitoring
  tracesSampleRate: 0.2,

  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',
})
```

**Interpretation:** Sentry is initialized with a DSN from env var, 20% trace sampling, production-only. No error filtering, no custom tags, no integrations beyond the default. Sentry captures thrown exceptions. Sentry does NOT capture silent failures (functions that return `{ data: null, error: {...} }` without throwing) unless the calling code explicitly calls `Sentry.captureException(error)` — which is not done in any of the form-completed routes or the audit-health-check route (verified by the absence of any `Sentry.capture` calls in those files during v1's agent audit).

#### 2.8.4 MCP tool count

**Test 1:** `Grep server.tool(` in `lib/mcp/tools/` → 206 matches across 41 files
**Test 2:** `Bash grep -v '//' app/api/[transport]/route.ts | grep 'register.*Tools'` → 41 register calls

**CLAUDE.md rule citation (R-related):** "NEVER count server.tool() across all files — some files may exist but not be registered. Only files with an uncommented import AND uncommented register*Tools(server) call are active. Before updating any tool count, verify with `grep -v '//' app/api/[transport]/route.ts | grep 'register.*Tools'`."

**Interpretation:** The v1 audit verified "206 tools" using `grep server.tool(` in the tools directory, which is the method CLAUDE.md explicitly prohibits. The 41 register calls in `route.ts` are the authoritative count of tool GROUPS. The 206 individual tools are spread across those 41 groups. Both numbers are technically correct but v1 used the wrong method to verify the 206 figure. The number is not obviously wrong; the methodology was.

#### 2.8.5 `vercel.json` cron registrations

**Test:** `Read` of `vercel.json` (132 lines)
**Finding:** 20 cron routes registered. Full list:
1. `/api/qb/refresh` (every 6h)
2. `/api/sync-drive` (every 6h)
3. `/api/sync-airtable` (every 6h)
4. `/api/cron/check-wire-payments` (every 6h)
5. `/api/cron/ra-renewal-check` (daily 9am)
6. `/api/cron/annual-report-check` (daily 9am)
7. `/api/cron/overdue-payments-report` (daily 9am)
8. `/api/cron/portal-issues` (hourly)
9. `/api/cron/email-monitor` (every 5 min)
10. `/api/cron/annual-installments` (monthly, 1st at 10am)
11. `/api/cron/deadline-reminders` (daily 8am)
12. `/api/cron/wizard-reminders` (daily 9:17am)
13. `/api/cron/process-jobs` (every 5 min)
14. `/api/cron/invoice-overdue` (daily 9am)
15. `/api/cron/faxage-ss4-confirm` (every 2h)
16. `/api/cron/portal-digest` (every 5 min)
17. `/api/cron/plaid-sync` (every 6h)
18. `/api/cron/mercury-sync?days=7` (every 15 min)
19. `/api/cron/portal-recurring-invoices` (daily 8am)
20. `/api/cron/audit-health-check` (daily 7am)

**NOT registered:** `/api/cron/stripe-sync`. v1 claimed the stripe-sync route exists in the codebase but is not registered. The first claim (route exists) was not re-verified in v2. The second claim (not in vercel.json) is confirmed.

### 2.9 Lifecycle state machine findings (from v1, not re-verified)

v1's lifecycle agent reported that the system has 5 parallel state tracks with no centralized orchestrator:
1. Lead status
2. Pending activation
3. Account status
4. Portal tier
5. SD status

And no code validates transitions (`changeAccountStatus` accepts any from→to pair). Cascades are opt-in via StatusChangeDialog checkbox. **None of these claims were re-verified in v2.** They are cited here for completeness but should not be treated as verified without re-reading the relevant files.

### 2.10 Test coverage findings (from v1, not re-verified)

v1's test coverage agent reported:
- 22 unit test files in `tests/unit/` with 287 test cases
- 14 E2E spec files in `tests/e2e/` with 248 test cases
- ZERO tests for any of: `lib/service-delivery.ts` (534 lines), `lib/installment-handler.ts` (407 lines), any of the 6 form-completed routes (2,427 lines total) — 3,368 lines of business-critical code with zero coverage
- `tests/unit/status-validation.test.ts:76` explicitly flags `service_deliveries` as unmapped — validation returns null for any value

**Not re-verified in v2.** If used for planning, these claims should be re-confirmed.

---

## 3. Retractions and corrections from v1

This section lists specific claims in v1 that v2's verification pass found to be wrong, over-stated, or under-stated.

### 3.1 Numeric corrections

| v1 claim | Reality | Source |
|---------|---------|--------|
| "25+ references across 10 files" (current_stage) | 35 references across 15 source files | Grep in v2 |
| "Manuel Burdo has only one SD" (implied) | Manuel has 2 SDs: 1 Formation (Post-Formation + Banking) + 1 ITIN (stuck at Data Collection) | SQL in v2 |
| "97 contacts no auth" | 95 | SQL in v2 |
| "35 active accounts zero docs" | 69 | SQL in v2 |
| `stop-check.sh:7` hardcoded path | Line 6 (off by one) | File read in v2 |
| Disease 1 timeline lists 5-6 bypass files but Section 0/4 says "10" | Internal inconsistency; also `activate-service` was mislabeled "Mixed" when it uses `stage` correctly | File reads in v2 |
| "PostgREST silently ignores unknown columns" | Direct SQL test shows 42703 on SELECT, PGRST204 equivalent on write; PostgREST behavior via SDK not directly tested | execute_sql + function signature check |
| 206 tools "verified" via `grep server.tool(` | CLAUDE.md says count `register*Tools` in route.ts (= 41 groups). Both numbers can be true (41 groups × multiple tools each = 206) but v1 used the wrong method. | CLAUDE.md rule + file read |

### 3.2 Severity corrections

**RC2 `getPortalActiveServices` — severity OVERSTATED**

v1 ranked this CRITICAL on the basis of "Portal nav visibility broken. Action items missing for multiple clients."

**v2 consumer trace:**
- `lib/portal/queries.ts:183-191` — function filters `service_deliveries.stage IN ('Active','Intake','Setup','Processing','Review')`
- Live data query: zero `service_deliveries.stage` values match this filter list (pipeline_stages values are things like "Upcoming", "Lease Created", "Data Received", not "Active"/"Intake"/etc.)
- Therefore `getPortalActiveServices` always returns `[]`
- `app/portal/layout.tsx:85` calls `getPortalActiveServices(selectedAccountId)` and binds the result to `activeServices` at line 83
- `app/portal/layout.tsx:127` passes `<PortalSidebar activeServices={activeServices} ... />`
- `components/portal/portal-sidebar.tsx:41` — type declaration: `activeServices?: string[]`
- `components/portal/portal-sidebar.tsx:114` — destructure with rename: `{ ..., activeServices: _activeServices, ... }`
- Lines 114-376 (the entire function body, read in full): **zero references to `_activeServices` or `activeServices`**. The prop is never used.

**Meanwhile, the actual nav flag for "services" comes from:**
- `lib/portal/queries.ts:209-296` — `getPortalNavVisibility()`
- Lines 219-226:
  ```typescript
  supabaseAdmin
    .from('service_deliveries')
    .select('service_name', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .then(r => ({ count: r.count ?? 0, names: [] as string[] }))
  ```
  — no stage filter, no status filter, counts every SD for the account
- Line 286: `services: serviceDeliveries.count > 0`

**Conclusion:** The broken `getPortalActiveServices` function's output is destructured with an unused-variable prefix and never referenced. The nav flag is driven by a completely separate stage-agnostic count. The "broken filter" has zero user-visible impact via the nav path. **Severity was inflated in v1 without consumer tracing.**

**This is the clearest case in v1 where a finding's severity was determined by "does the code do what its name implies?" rather than "does the break cause user harm?"**

### 3.3 Framing corrections

**v1 claim: "PostgREST silently ignores unknown columns, so writes return success but stage data is lost."**

**v2 reality (partial):**
- Direct SQL test of `exec_sql(query := 'SELECT 1')` returns `42883 function does not exist` — the wrong-parameter-name version errors loudly
- PostgREST behavior via Supabase JS client is not directly tested, but the chain of empirical evidence (cron_log showing `findings: []` consistently, while real violations exist) is most consistent with "PostgREST errors, SDK returns null data, calling code doesn't check error, branch treats null as no-data and moves on"
- This is NOT "silent ignoring" — it is "loud error that's in-band silenced by the calling code that doesn't destructure `error`"

**This distinction matters for two reasons:**
1. The fix is different — "silent ignoring" implies you need a way to detect the silent failures; "loud error that's silenced" implies you need to add error destructuring and the failures will surface
2. The audit trail is different — "silent ignoring" leaves no evidence anywhere; "loud error" leaves 4xx responses in PostgREST/Supabase logs that can be queried to prove the bug window (though we have not accessed those logs in this session)

**v1 claim: "30+ data-corrupting bugs"**

**v2 reality:** Not all 30+ items in v1's list are "data-corrupting" in the sense of actually writing bad data. Many are:
- Read-side reads that return undefined/error (no bad data written)
- Filter values that return empty results (no bad data, just wrong answers to queries)
- Dead code whose output is never consumed
- Enum drift in `constants.ts` that doesn't affect runtime behavior unless the code actually writes the drifted values
- Hardcoded strings that are wrong but where the surrounding code paths may not be exercised

**The actually-verified data-corrupting bugs are:**
- 11 write-side `current_stage` sites where the wrong column is written (6 INSERT + 5 UPDATE), subject to the PostgREST mixed-write uncertainty for `tax-form-setup.ts:290`
- `formation-setup.ts:155` writes `account_type: "Formation"` which violates the CHECK constraint (cited from v1, not re-verified end-to-end in v2)
- `service-delivery.ts:204` writes `portal_tier: "full"` which is not in the accounts CHECK constraint (cited from v1, not re-verified end-to-end in v2)

**v1 claim: "The 7-phase restructure is necessary to prevent recurrence"**

**v2 reality:** The infrastructure to detect these issues already exists (audit-health-check cron + SQL file). It's just broken. Fixing the existing infrastructure is a much smaller change than building a new restructure. v1's Phase 5 (building a health check cron) was literally redundant — one exists.

### 3.4 Missed findings that v1 should have caught but didn't

**a.** `audit-health-check` cron in `vercel.json:79-82` and `app/api/cron/audit-health-check/route.ts` — pre-existing infrastructure. v1 said "no health check cron exists" and proposed building one. A search of `vercel.json` at the time would have found it.

**b.** `scripts/audit-health-check.sql` (629 lines, 39 checks) covering nearly everything v1's B-series queries found. A search of the `scripts/` directory at the time would have found it.

**c.** `exec_sql` RPC function with `sql_query text` signature. v1 did not verify the function exists or check its signature. v2 verified via `pg_proc`.

**d.** 4 additional `query:` vs `sql_query:` bugs in `lib/mcp/tools/referrals.ts:344`, `lib/mcp/tools/operations.ts:1113`, `lib/mcp/tools/operations.ts:1134` (3 sites) and `audit-health-check/route.ts:170` (1 site besides the primary call at :28). v1 did not grep for `rpc\("exec_sql"`.

**e.** `lib/types.ts:333` declares `current_stage: string | null` as a TypeScript interface property. v1 did not include this file in its `current_stage` inventory.

**f.** `app/portal/services/page.tsx` and `app/portal/page.tsx` both reference `current_stage` for display. v1 did not inspect portal pages beyond layout/login/sign/wizard.

---

## 4. Grounded unknowns (what v2 has NOT verified)

Explicit list of claims v2 cannot make with direct evidence:

**U1.** **The Supabase JS SDK's exact error propagation for `rpc("exec_sql", { query: "..." })`.** Raw SQL test shows `42883`. SDK-level behavior is inferred from documentation + empirical cron_log evidence, not observed via a live test script. To resolve: write a minimal Node script that calls `supabaseAdmin.rpc("exec_sql", { query: "SELECT 1" })` and observe whether the response's `error` field is populated.

**U2.** **PostgREST behavior on MIXED-column writes** (one valid + one invalid column in the same payload). The test session's direct function call tests only covered pure broken payloads. The `tax-form-setup.ts:284-295` UPDATE writes both `stage` and `current_stage`. To resolve: construct a minimal test write against a safe row.

**U3.** **The correct runtime mechanism for loading `scripts/audit-health-check.sql` into the route.** v2 knows the current `AUDIT_SQL` constant at line 194 is a stub and that the route has no `readFile` or import. v2 does NOT know which pattern the project uses for loading SQL at runtime in Next.js serverless. No other file in the codebase was found via grep that imports `.sql` files (grep did not return matches for `audit-health-check\.sql` outside the route comment and the file itself). Possible mechanisms (all unverified):
- Convert the 629-line CTE into a TypeScript template string constant inline in the route file
- Use Next.js `import` with a custom loader (not verified to be configured in this project)
- Call the SQL via a separate database function/view (not verified to exist)

**U4.** **Whether the 3 other `query:` sites in `referrals.ts` and `operations.ts` are failing in production.** v2 only confirmed the parameter name mismatch at the SQL level. Whether the MCP tools that contain these calls have been returning empty results silently in production is not verified. To resolve: check `action_log` or manually run the MCP tools and observe their output.

**U5.** **`supabase gen types` output.** v2 infers (based on PostgREST's schema cache behavior and the absence of `current_stage` in the DB) that generated types would catch the 11 write-side bugs. NOT run. To resolve: execute `npx supabase gen types typescript --project-id ydzipybqeebtpcvsbtvs > /tmp/db.types.ts` and grep the output for `service_deliveries` type definition.

**U6.** **Stuck clients in formation, onboarding, closure, banking, tax_return submissions.** v2's query errored on schema mismatch (`formation_submissions.account_id` doesn't exist). A corrected query was not re-run. Count of stuck clients beyond Manuel Burdo's ITIN is UNKNOWN.

**U7.** **27 CRM dashboard pages + 33 portal pages.** 5 of each were sampled in v2; the remainder are not audited. Sampled pages showed scattered hardcoded filter values (`'Active'`, `'Paid'`, `'Completed'`) that may or may not match DB expectations. No systematic review was done.

**U8.** **Whether the 56 cancelled/closed accounts with active portal_tier have any production effect.** Verified they exist. Not verified whether the clients they belong to can still log in to the portal (depends on whether their auth.users records are still active, which was not queried for each specific account).

**U9.** **Actual production logs from Vercel, Sentry, or Supabase.** None accessed. A production log check would likely settle several of the above unknowns instantly (e.g., U1, U4) but requires dashboard access this session does not have.

**U10.** **Whether any component of the system writes `"full"` to `accounts.portal_tier` in production and gets rejected.** v1's enum agent claimed `service-delivery.ts:204` writes `"full"`. Not directly re-verified in v2. Not tested against the accounts CHECK constraint (though v1 reports the CHECK allows `lead/onboarding/active/suspended/inactive` but not `full`).

---

## 5. The remediation plan

### 5.1 Structural principles

Every change in this plan follows these rules:

1. **Cite before changing.** Every proposed edit lists the file:line evidence that proves the change is needed.
2. **Verification gate between steps.** No step is considered "done" until its verification test passes.
3. **Data fixes separate from code fixes.** A data UPDATE is reversible via another UPDATE; a code edit needs a revert commit. Keeping them separate means a bad code fix doesn't force a data revert.
4. **No speculative restructures.** `lib/operations/` canonical layer, health monitoring dashboards, characterization test suites — none of these are in this plan. They can be added later if needed.
5. **Single machine, single session.** Multi-machine parallelization is not justified by the scope.

### 5.2 Decisions required before execution

**D1. Legacy Onboard stage.** The 124 Annual Renewal SDs in Section 2.3.2 need a stage value. Options (not all may be valid; the actual pipeline_stages for Annual Renewal were not queried in this session — see U12 below):
- `Upcoming` — if they represent future-dated renewals
- `Active` — if they represent in-progress renewals
- Something else based on Annual Renewal's actual pipeline definition

**Action required:** Query `SELECT DISTINCT stage_name, stage_order FROM pipeline_stages WHERE service_type = 'Annual Renewal' ORDER BY stage_order` to see the valid options, then decide which applies.

**D2. PostgREST mixed-write test.** `tax-form-setup.ts:284-295` writes both `stage` and `current_stage` in the same UPDATE. Whether this has been silently succeeding (PostgREST drops unknown key, valid `stage` lands) or silently failing (PostgREST rejects whole payload, `sdErr` fires) is not tested. A 10-minute test via a disposable test row would settle it.

**Action required:** Decide whether to run the test before fixing `tax-form-setup.ts:290`, or accept the uncertainty and fix the line anyway (removing the `current_stage` key preserves the correct write either way).

**D3. SQL loading mechanism for audit-health-check fix.** See U3. Three options:
- α. Inline the 629-line CTE as a TypeScript template literal in `route.ts`
- β. Keep the route as-is and instead rewrite `runChecksIndividually()` to include all 39 checks as inline individual queries
- γ. Create a Postgres view or function that wraps the CTE and have the route call it with a simple `SELECT * FROM audit_health_view`

**Action required:** Pick one. Option γ is cleanest architecturally but requires a DB migration. Option α is simplest. Option β removes the RPC dependency entirely at the cost of 39 separate round-trips.

**D4. Stripe cron registration.** `/api/cron/stripe-sync` is not in `vercel.json`. Whether to register it depends on whether Stripe bank feed syncing is desired for the business. Not a technical decision — a product decision.

**D5. Other form types stuck count.** Before running mass data fixes, v2 recommends re-running the stuck-client query for formation/onboarding/closure/banking/tax_return with corrected schema joins. Otherwise the "rescue stuck clients" step has an unknown number of rows.

### 5.3 Plan

#### Part A — Fix the audit-health-check cron (HIGHEST LEVERAGE)

**Goal:** Turn the existing broken daily audit into a working daily audit that surfaces the violations v2 re-verified. Once this works, subsequent parts become easier to verify because the cron will report their resolution.

**A1. Fix the parameter name mismatch.**

File: `app/api/cron/audit-health-check/route.ts`
- Line 28: change `query: AUDIT_SQL,` to `sql_query: AUDIT_SQL,`
- Line 170: change `{ query: check.sql }` to `{ sql_query: check.sql }`

Cited by: `lib/mcp/tools/sql.ts:345, 370` which use the correct pattern.

**A2. Replace the `AUDIT_SQL` stub.** (Depends on D3.)

Current state (line 194): a 1-row placeholder returning `rpc_not_configured`.

Options recap:
- α. Inline the CTE as a template literal
- β. Rewrite `runChecksIndividually()` with all 39 checks inline
- γ. Create a DB function wrapping the CTE

**A3. Verification gate.**

After A1+A2, manually trigger the cron via its route (e.g., `curl https://<host>/api/cron/audit-health-check -H "Authorization: Bearer $CRON_SECRET"`). Observe the JSON response. Expected result:
- `summary.p1 > 0` (at least the tier mismatches + stuck activations should fire)
- `summary.p2 > 0` (at least 124 NULL stages should fire via Check 28)
- `findings[]` array contains rows for: `sd_null_stage`, `portal_tier_contact_account_mismatch`, `portal_tier_contact_auth_mismatch`, `sd_stage_invalid_for_type`, `active_sd_cancelled_account`

If the response still shows all zeros, something else is wrong and Part A is NOT complete. Do not proceed to Part B until Part A's verification gate passes.

**A4. Monitoring.**

Once Part A works, the `dev_tasks` table will start receiving `[AUTO] Audit Health Check: N P0 issue(s) found` entries on any day with P0 findings. Any subsequent data fix can be verified by watching whether the corresponding check disappears from the next day's cron report.

#### Part B — Data fixes (requires Part A working for verification)

**B1. Manuel Burdo's ITIN.**

Operation:
```sql
UPDATE service_deliveries
SET stage = 'Document Preparation',
    stage_order = 2,
    updated_at = now()
WHERE id = '746faa3a-3202-47c1-a0df-e212aac3a432'
```

Verification:
- Re-run the Section 2.2.1 query. Manuel's row should no longer match the filter.
- Part A's next day run of Check 28 should NOT include this ID (it was not stuck on Check 28 anyway — Check 28 is NULL-stage; Manuel's SD has a non-null stage).
- What Manuel's SD WAS stuck on: nothing the audit-health-check covers directly. There is no check for "SD stuck at stage X longer than N days since the corresponding submission completed." This check could be added but is out of scope for Part B.

**B2. The 124 Legacy Onboard Annual Renewal SDs.** (Depends on D1.)

Operation (template, pending D1):
```sql
UPDATE service_deliveries
SET stage = '<DECISION PENDING>',
    stage_order = <TBD>,
    updated_at = now()
WHERE status = 'active'
  AND stage IS NULL
  AND service_type = 'Annual Renewal'
  AND notes = 'Legacy onboard'
```

Verification: Part A's next day run. Check 28 (`sd_null_stage`) should report 0 rows.

**B3. Cancelled/Closed accounts with active portal_tier.**

Operation:
```sql
UPDATE accounts
SET portal_tier = 'inactive',
    updated_at = now()
WHERE status IN ('Cancelled', 'Closed', 'Offboarding')
  AND portal_tier IN ('active', 'full')
```

**WARNING:** `portal_tier = 'inactive'` may not be a valid value in the accounts CHECK constraint. v1's enum agent reported the accounts CHECK allows `lead, onboarding, active, suspended, inactive` (5 values). This is cited from v1 and NOT re-verified in v2. **Before running this UPDATE, re-verify the CHECK constraint:** `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND contype = 'c' AND conname LIKE '%portal_tier%'`.

If `inactive` is not allowed, choose from the allowed values. If the CHECK only allows `lead/onboarding/active`, then you need to either (a) add `inactive` to the CHECK or (b) set the cancelled accounts to `lead` (demotes them to the minimum tier).

Verification: Section 2.7.3 Check 29/30 re-runs should show fewer rows.

**B4. 2 contact/account tier desyncs.** (From v1 B6: Hamid Oumoumen, Damiano Mocellin.)

NOT re-verified in v2. Re-query first:
```sql
SELECT c.id as contact_id, c.full_name, c.portal_tier as contact_tier,
       a.id as account_id, a.company_name, a.portal_tier as account_tier
FROM contacts c
JOIN account_contacts ac ON ac.contact_id = c.id
JOIN accounts a ON a.id = ac.account_id
WHERE c.portal_tier IS DISTINCT FROM a.portal_tier
  AND c.portal_tier IS NOT NULL
  AND a.portal_tier IS NOT NULL
```
Decide for each row whether to align contact → account or account → contact.

**B5. 4 auth/contact tier desyncs.** (From v1 B5: marra, awy, johannestabrizi, uxio test account.)

NOT re-verified in v2. Re-query first via the B5 SQL from v1:
```sql
SELECT au.email, au.raw_app_meta_data->>'portal_tier' as auth_tier, c.portal_tier as contact_tier
FROM auth.users au
JOIN contacts c ON c.id::text = au.raw_app_meta_data->>'contact_id'
WHERE au.raw_app_meta_data->>'role' = 'client'
  AND au.raw_app_meta_data->>'portal_tier' != c.portal_tier
```
Sync each row (auth → contact or contact → auth).

**B6. Stuck clients from other form types.** (Depends on D5.)

Re-run the stuck-client query with corrected schemas for each submission table. For each stuck client found, apply an appropriate stage advance.

**B7. 69 active accounts with zero documents.** NOT a single UPDATE operation. Each account needs triage:
- Legitimate one-time clients who never needed documents → leave alone
- Active business clients who should have OA + Lease → generate documents via existing MCP tools (`oa_create`, `lease_create`)
- Clients who were supposed to be set up but weren't → complete the setup manually

**This is operational work, not a remediation SQL step.** It is listed here because v2 re-verified the count but cannot propose a blanket fix.

#### Part C — Code fixes (mechanical, independent of Parts A and B)

**C1. Hook script hardcoded paths.**

File 1: `.claude/hooks/pre-compact-save.sh`
- Line 8: change `REPO_DIR="/Users/tonydurante/Desktop/td-operations"` to `REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"`

File 2: `.claude/hooks/stop-check.sh`
- Line 6: same change

Cited by: `.claude/hooks/session-git-pull.sh` (from v1 agent, not re-read in v2) which uses the dynamic pattern. Recheck via `Read` before editing to confirm the dynamic pattern is correct for this project.

**C2. `current_stage` write-side fixes (11 sites).**

For each of the 6 INSERT sites and 5 UPDATE sites listed in Sections 2.1.4 and 2.1.5, change the key name from `current_stage` to `stage`. The values stay the same.

For `tax-form-setup.ts:290` (the mixed-write case), the key can be removed entirely since line 287 already writes `stage: "Data Received"`.

Verification gate: `grep -rn "current_stage:" app/ lib/` (excluding `lib/portal/queries.ts`, `lib/types.ts`, and `app/(dashboard)/services/page.tsx` which are the harmless read-alias sites) should return zero results.

**C3. `current_stage` read-side fixes (7 SELECT sites + downstream reads).**

For each of the 7 `.select("id, current_stage")` or similar sites in Section 2.1.6, change the column list to use `stage` instead. Then update the downstream references from `current_stage` to `stage`.

**Complication:** Some downstream sites (`app/portal/services/page.tsx:117-118`, `app/portal/page.tsx`) read `s.current_stage` from objects that come from `getPortalServices()` which uses the harmless alias pattern. These can stay as-is — the alias makes them work. If you also change the alias (e.g., rename the TypeScript property from `current_stage` to `stage` in the query output), you'd need to update the UI sites too.

**Recommendation:** Leave the harmless read-aliases in place. Change only the broken SELECT sites and their immediate downstream reads. This preserves the UI contract and minimizes churn.

**C4. `query:` → `sql_query:` in other files.** (Beyond Part A.)

- `lib/mcp/tools/referrals.ts:344` — change `query:` to `sql_query:`
- `lib/mcp/tools/operations.ts:1113` — change `query:` to `sql_query:`
- `lib/mcp/tools/operations.ts:1134` — change `query:` to `sql_query:`

These are separate from Part A and may need separate verification. v2 has not traced the consumers of these calls (U4).

**C5. Stripe cron.** (Depends on D4.)

If D4 is "yes, sync Stripe," add to `vercel.json`:
```json
{
  "path": "/api/cron/stripe-sync",
  "schedule": "0 */6 * * *"
}
```

Not in scope if D4 is "no" or "defer."

#### Part D — Type safety (prevention, longer-term)

**D1. Generate types.**

Command: `npx supabase gen types typescript --project-id ydzipybqeebtpcvsbtvs > lib/database.types.ts` (or equivalent)

Verification: `cat lib/database.types.ts | grep -A 20 'service_deliveries'` should show a TypeScript type with `stage: string | null` (and no `current_stage`).

**D2. Replace the `as any` proxy.**

File: `lib/supabase-admin.ts`
Current:
```typescript
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!_supabaseAdmin) {
      _supabaseAdmin = createClient(...)
    }
    return (_supabaseAdmin as any)[prop]
  },
})
```

Proposed pattern (needs verification that it fits the project's import patterns):
```typescript
import { Database } from './database.types'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient<Database> | null = null

export function getSupabaseAdmin(): SupabaseClient<Database> {
  if (!_client) {
    _client = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _client
}

// Backward-compat proxy for existing imports of `supabaseAdmin`
export const supabaseAdmin = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    return (getSupabaseAdmin() as any)[prop]
  },
})
```

**CAUTION:** This still uses `as any` inside the proxy for property lookup. The proxy pattern does not trivially expose typed methods. An alternative is to migrate all callers from `supabaseAdmin.from(...)` to `getSupabaseAdmin().from(...)`, which is a ~100-file change. **This is a larger refactor than the rest of Part D and may be deferred or skipped.**

**D3. Run `npm run build` and fix surfaced errors.**

This is the actual bug-finder. Every TypeScript error that surfaces is either a real bug or a legitimate type mismatch that needs a cast. Triage each.

Verification: `npm run build` exits 0 with no errors.

**D4. Sync `lib/constants.ts` with DB enums.**

v1 identified 8+ enum drifts (Section 4 RC8 of v1, not re-verified individually in v2). Run a grep for `export const.*_STATUS = \[` in `lib/constants.ts` and compare each array against the corresponding `pg_constraint` check definition.

**This is tedious manual work with 20+ enums.** Alternatively, generate the constants from the DB via a script and import them.

#### Part E — Explicitly out of scope

Things v1 proposed that v2 does NOT recommend:

1. **Multi-machine parallel execution** — scope is too small to benefit. One machine, one session.
2. **`lib/operations/` canonical operations layer** — speculative. Not justified by any verified bug. The "client care anti-pattern" is real but a canonical library is not the only solution.
3. **Characterization tests before refactoring** — the fixes are mechanical find/replace, not structural refactors. Characterization tests are for when you need to preserve complex existing behavior through a rewrite; a column name change doesn't qualify.
4. **Mass refactor of form-completed routes through a shared `createServiceDelivery()` function** — each route has its own surrounding business logic. Extracting just the SD creation step is a minor cleanup that can happen later if drift recurs.
5. **Building a new health check cron** — one already exists. Fix it.
6. **Building a violations dashboard** — the existing cron already writes to `dev_tasks` for P0 findings. That IS the dashboard entry point.
7. **Audit of all 206 MCP tools** — scope too large. The 3 tools with `query:` bugs (referrals, operations ×2) are fixed in C4. Other tools may have issues but not in scope for this plan.
8. **Audit of all 32 CRM pages + 38 portal pages** — scope too large. Type safety (Part D) will surface any wrong column references automatically once it runs.

---

## 6. Execution order and verification gates

This ordering minimizes risk and maximizes the value of each step:

**Step 1 (Decisions):** Antonio answers D1–D5.

**Step 2 (Safety):** C1 (hook script paths). 2 lines changed in 2 files. No runtime effect on production. Unblocks future multi-machine sessions.

**Step 3 (Monitoring infrastructure):** Part A (fix audit-health-check cron). Enables verification for all subsequent steps.

**Step 4 (Verification Gate A):** Manually trigger the cron. Expected: P1+P2 findings appear. If not, STOP and diagnose.

**Step 5 (Data fixes):** Part B in order B1→B2→B3→B4→B5→B6. After each, observe the next cron run to confirm the finding count drops.

**Step 6 (Code fixes):** Part C in order C2→C3→C4. Each is mechanical. After all three, `npm run test:unit` and `npm run build` should still pass.

**Step 7 (Operational cleanup):** B7 (document triage) — slow operational work, not blocking.

**Step 8 (Type safety):** Part D. Longest to complete. May surface additional issues that require a new planning pass.

**Step 9 (Optional):** C5 (Stripe cron) if D4 is "yes."

---

## 7. Time estimate

**Parts A + B1 + B2 + B3 + C1 + C2 + C3:** 2-4 hours of focused work on one machine, assuming D1–D3 are decided quickly.

**Part D (type safety):** UNKNOWN. Generating types is fast (~30 seconds). Running `npm run build` and triaging errors could be 1 hour or 4 hours depending on how many legitimate type mismatches exist vs how many need casting. v2 has not run this experiment — see U5.

**Part B7 (document triage):** Operational work, not engineering. Timeline depends on Antonio/Luca availability.

**Parts C4 + C5:** < 30 minutes combined.

**Total engineering time:** ~4-8 hours, single machine, single session or split across 2 short sessions with a verification pause after Part A.

---

## 8. What happens if this plan is NOT executed

Doing nothing is also an option. If the plan is not executed:

- Manuel Burdo's ITIN stays stuck indefinitely (client-visible)
- 124 Legacy Onboard Annual Renewal SDs continue to have NULL stage (cosmetic in CRM, unknown effect on any automation that reads `stage`)
- 56 cancelled accounts with active portal_tier can theoretically still see portal (status-dependent)
- The audit-health-check cron keeps logging `success: true` with zero findings — false sense of security
- Future sessions on different machines continue to write `current_stage` and lose data (every new form completion that touches these routes is a new stuck client)
- The hook scripts silently fail on 2 of 3 machines — context loss risk between sessions
- Error destructuring absent in ~all `service_deliveries` calls — new bugs silently land

**Cost of inaction:** Cumulative drift. Each week adds a handful of new stuck clients and a handful of silently-broken writes. The audit-health-check cron catches none of them because of the parameter name bug.

**Cost of this plan:** 4-8 engineering hours + operational triage for document-less accounts + type safety experiment time.

**v2 recommendation:** Execute Parts A through C at minimum. Defer or skip Part D until it's clear whether the mechanical fixes (Parts A-C) are sufficient. Revisit Part D after 2 weeks of clean cron runs.

---

## 9. Appendices

### Appendix A — All `execute_sql` queries run in v2's verification pass

1. `SELECT column_name FROM information_schema.columns WHERE table_name = 'service_deliveries' AND column_name IN ('stage', 'current_stage')` → 1 row: `stage`
2. `SELECT id, current_stage FROM service_deliveries WHERE status = 'active' LIMIT 1` → error 42703
3. `SELECT ... FROM itin_submissions ... WHERE s.status = 'completed' AND sd.updated_at < s.completed_at AND sd.stage = 'Data Collection'` → 1 row (Stay Legit LLC)
4. `SELECT service_type, count(*), min(created_at), max(created_at), count(DISTINCT assigned_to) FROM service_deliveries WHERE status = 'active' AND stage IS NULL GROUP BY service_type` → 1 row (Annual Renewal, 124)
5. `SELECT notes, assigned_to, count(*) FROM service_deliveries WHERE status = 'active' AND stage IS NULL AND service_type = 'Annual Renewal' GROUP BY notes, assigned_to` → 1 row (Legacy onboard / Luca / 124)
6. `SELECT service_type, stage_name, stage_order FROM pipeline_stages WHERE service_type IN ('Company Formation', 'Tax Return', 'ITIN')` → 24 rows
7. Contact-no-auth query → 95
8. `SELECT status, count(*), count(CASE WHEN portal_tier IN ('active','full') THEN 1 END) FROM accounts WHERE status IN ('Cancelled', 'Closed', 'Offboarding', 'Suspended') GROUP BY status` → 43 / 11 / 1 / 1 = 56
9. Active accounts zero docs query → 69
10. `SELECT column_name FROM information_schema.columns WHERE table_name = 'cron_log'` → 7 columns (id, endpoint, status, duration_ms, error_message, details, executed_at) — note: NOT `created_at`
11. `SELECT endpoint, status, duration_ms, error_message, details, executed_at FROM cron_log WHERE endpoint = '/api/cron/audit-health-check' ORDER BY executed_at DESC LIMIT 10` → 5 success rows, all with `p0/p1/p2 = 0` and `findings: []`
12. `SELECT proname, pg_get_function_arguments(oid) FROM pg_proc WHERE proname = 'exec_sql'` → 1 row: `exec_sql(sql_query text)`
13. `SELECT * FROM public.exec_sql(sql_query := 'SELECT 1 AS test, ''hello'' AS msg')` → success, returned `[{test: 1, msg: 'hello'}]`
14. `SELECT * FROM public.exec_sql(query := 'SELECT 1 AS test')` → error 42883 `function public.exec_sql(query => unknown) does not exist`
15. Check 28 logic directly → 124 records_affected, Annual Renewal
16. `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('formation_submissions', 'onboarding_submissions', ...) AND column_name IN ('account_id', 'contact_id', ...)` → confirmed formation_submissions lacks account_id
17. `SELECT * FROM cron_log WHERE ... ORDER BY executed_at DESC LIMIT 10` → various action_log rows including the 2026-04-09 raw SQL cleanup of 43 SDs

### Appendix B — All file reads in v2

1. `lib/supabase-admin.ts` (24 lines, full)
2. `lib/service-delivery.ts` lines 1-534 (from v1, referenced in v2)
3. `lib/constants.ts` lines 1-261 (from v1, referenced in v2)
4. `sentry.server.config.ts` (12 lines, full)
5. `app/api/[transport]/route.ts` lines 1-218 (full)
6. `.claude/hooks/pre-compact-save.sh` lines 1-20
7. `.claude/hooks/stop-check.sh` lines 1-20
8. `app/api/itin-form-completed/route.ts` lines 180-231
9. `app/portal/services/page.tsx` lines 1-100 sample (from agent)
10. `app/portal/invoices/page.tsx`, `chat/page.tsx`, `deadlines/page.tsx`, `documents/page.tsx` samples (from agent)
11. `app/(dashboard)/accounts/page.tsx`, `tasks/page.tsx`, `finance/page.tsx`, `services/page.tsx`, `trackers/[serviceType]/page.tsx` samples (from agent)
12. `components/portal/portal-sidebar.tsx` lines 41-376 (full function body, in verification pass)
13. `lib/portal/queries.ts` lines 183-296 (in verification pass)
14. `app/portal/layout.tsx` lines 80-140 (in verification pass)
15. `app/api/cron/audit-health-check/route.ts` lines 1-194 (full)
16. `scripts/audit-health-check.sql` lines 1-629 (full, in 3 passes)
17. `lib/jobs/handlers/tax-form-setup.ts` lines 280-299
18. `lib/mcp/tools/sql.ts` lines 340-400
19. `vercel.json` lines 1-132 (full)

### Appendix C — All Grep results in v2

1. `current_stage` (whole repo) → 48 occurrences, 17 files (35 / 15 after excluding docs)
2. `current_stage:\s*sd\.stage|current_stage:\s*s\.stage|current_stage:\s*.+\.stage` → 5 read-alias sites
3. `\.insert\(.*current_stage|\.update\(.*current_stage|current_stage:\s*["']` → write-side sites
4. `error:\s*\w+[Ee]rr.*from\(.service_deliveries|\{\s*error\s*[:,].*from\(.service_deliveries` → 1 match (audit-chain/route.ts:1451)
5. `server\.tool\(` in `lib/mcp/tools` → 206 / 41 files
6. `rpc\(["']exec_sql["']` → 8 call sites (3 correct, 5 wrong)
7. `activeServices|_activeServices` in `components/portal/portal-sidebar.tsx` → 2 matches, both at declaration/destructure only
8. `if \(.*\.error\)|throw new Error|return.*error:|\.error\b` in form-completed routes → low counts confirming sparse error checking
9. `AUDIT_SQL|audit-health-check\.sql|readFile|readFileSync|import.*sql` in route.ts → 5 matches, all in comments or the constant itself

### Appendix D — Files NOT read in v2 that may still contain issues

1. `app/api/portal/search/route.ts` (referenced for `current_stage` but not opened in v2)
2. `app/api/internal/ai-assist/route.ts` (same)
3. `lib/mcp/tools/referrals.ts` (wrong `query:` parameter, not opened)
4. `lib/mcp/tools/operations.ts` (two wrong `query:` sites, not opened)
5. `app/api/formation-form-completed/route.ts` (cited but not opened in v2)
6. `app/api/onboarding-form-completed/route.ts` (same)
7. `app/api/closure-form-completed/route.ts` (same)
8. `app/api/tax-form-completed/route.ts` (cited but not opened in v2)
9. 27 of 32 CRM dashboard pages
10. 33 of 38 portal pages
11. Most of `lib/jobs/handlers/`
12. All MCP tool files beyond `sql.ts`, `operations.ts`, `referrals.ts`, `messaging.ts` samples

---

## 10. Change log

- 2026-04-14 ~04:30 — v1 audit (10 agents) complete
- 2026-04-14 ~04:45 — v1 deep-dive agents (4) complete
- 2026-04-14 ~05:00 — v1 plan drafted and uploaded to Drive
- 2026-04-14 ~13:00 — Independent critique returns, v1 claims challenged
- 2026-04-14 ~14:00 — v2 verification pass begins
- 2026-04-14 ~14:30 — `current_stage` count corrected (25+ → 35/15)
- 2026-04-14 ~14:45 — RC2 dead-code consumer discovered via portal-sidebar full read
- 2026-04-14 ~15:00 — Manuel Burdo ITIN case verified via SQL join
- 2026-04-14 ~15:30 — 124 NULL-stage SDs traced to Legacy Onboard bulk event (2026-04-09)
- 2026-04-14 ~15:45 — PostgreSQL `exec_sql` function signature verified via `pg_proc`
- 2026-04-14 ~16:00 — Direct function call tests: correct param works, wrong param errors 42883
- 2026-04-14 ~16:10 — audit-health-check cron discovered in `vercel.json:79-82`
- 2026-04-14 ~16:15 — Cron route file read end-to-end, stub at line 194 discovered
- 2026-04-14 ~16:20 — `scripts/audit-health-check.sql` (629 lines) read in full
- 2026-04-14 ~16:23 — Cron log verified: 5 consecutive days of false-zero findings
- 2026-04-14 ~16:25 — Check 28 logic verified directly: would find 124 NULL stages
- 2026-04-14 ~16:30 — All 8 `rpc("exec_sql")` call sites enumerated (3 correct, 5 wrong)
- 2026-04-14 ~16:45 — v2 remediation plan drafted (this document)

---

## 11. Bottom line

The system is not broken the way v1 described. The system has one significant infrastructure bug (the audit-health-check cron) that, if fixed, would automatically detect nearly all the data issues v1 reported. That fix is ~3 lines of code plus a decision about how to load the SQL file. Everything else is a small number of mechanical find-replaces and a handful of data UPDATEs.

The architectural restructure proposed in v1 is not justified by any verified finding in v2. It can be deferred indefinitely without client harm, provided Parts A through C of this plan execute successfully.

v2 is intentionally smaller than v1. This is a feature, not a bug. Smaller scope means fewer assumptions, fewer unverified claims, fewer opportunities for drift during execution.

**Awaiting decisions D1–D5 before execution begins.**
