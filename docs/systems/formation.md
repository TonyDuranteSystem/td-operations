# Company Formation
_Last verified against code: 2026-06-10 — Claude (added partial unique index uq_formation_sd_active_per_offer + service_deliveries.source_offer_token to make the duplicate-formation race impossible at the DB level — Michele Cotti got two formation SDs 2s apart; prior 2026-06-09 formation-materialize.ts forces 'formation' tier via syncTier allowDowngrade:true; 2026-06-08 PR #96 contact-scoped Company Formation SD at activation + formation-setup.ts dedupe)_

## What it is
The end-to-end flow of creating a client's US LLC: from a signed formation offer + payment, through filing the company with the state, to receiving the EIN — at which point the client becomes a fully active client. It's the core product, multi-step, and several automatic side-effects fire at each stage, so it's high-risk to touch blindly.

## The lifecycle (happy path)
1. **Signed + paid** → `activateService()` (`lib/operations/activation.ts`) orchestrates lead→contact, ensure-account, create service deliveries, set tier. It creates a **"Company Formation"** service delivery (SD) — **contact-scoped (`account_id=NULL`)** because the LLC does not yet exist (Articles pending). The SD's `notes` carries the offer_token for dedupe, and the token is also stored first-class in `service_deliveries.source_offer_token`. **A partial unique index `uq_formation_sd_active_per_offer` on `(contact_id, source_offer_token)` WHERE `service_type='Company Formation' AND account_id IS NULL AND status='active' AND source_offer_token IS NOT NULL` makes a duplicate physically impossible** — two concurrent/retried activations for the same offer can no longer both insert (the TOCTOU that gave Michele Cotti two formation SDs 2s apart, 2026-06-10). `activate-service` catches the unique violation and re-selects the winner, so the race is silent. The key is per-offer, so a legitimate second simultaneous new-company formation (different offer = different token) is unaffected. `formation-setup.ts` dedupes at wizard submit so no double-create.
2. **Account starts at tier `formation`** (company being formed, no EIN yet). Account status "Pending Formation". The client sees a **formation-specific dashboard/wizard**. Tier is derived by `tierForContract('formation')` → `'formation'` (`lib/portal/auto-create.ts`). **Exception — returning active client:** when the contact is already at tier `active` from another LLC, `syncTier` correctly refuses to downgrade. No new account row is created at payment either. The portal switcher (`getInProgressFormations` in `lib/portal/queries.ts`) sources the new entity directly from the contact-scoped Company Formation SD — the client sees a switcher with the existing LLC + "New company (in formation)", and the formation entity carries `tier='formation'` implicitly via `resolveSelectedEntity`.
3. **Formation data reviewed** (`formation_form_review` tool) — can upgrade tier onboarding→formation and advances the SD.
4. **Filing with the state** happens via Harbor Compliance (see the compliance system / `hc_*` tools).
5. **EIN received** → the formation→active hand-off runs (see below). Tier advances to **`active`**; the client gains full portal access (documents, invoices, chat).

## The EIN→active hand-off (the critical transition)
Canonical implementation: `triggerEINReceivedWorkflow()` in `lib/operations/ein-received.ts`. Triggered by the **"Record EIN Received" button** (`POST /api/crm/admin-actions/record-ein-received`) or the `enter_ein` action (`app/api/crm/admin-actions/contact-actions/route.ts`). It finds the active "Company Formation" SD and, **each step idempotent**:
1. Creates (or finds) a **"Banking Fintech"** SD.
2. Advances the formation SD to stage **"Post-Formation + Banking"**.
3. `syncTier({ newTier: 'active' })` — promotes the account.
4. Enqueues the **`welcome_package_prepare`** job.
5. Logs everything to `action_log`.

## Business rules
- **R102** — Portal tier has exactly 4 values (`lead`, `formation`, `onboarding`, `active`). All tier writes go through `syncTier()` in `lib/operations/sync-tier.ts` — **never write `portal_tier` directly, never advance tier manually.** `formation` = no EIN yet; EIN advances it to `active`.
- **R106** — Service types live in the catalog (`catalog_entries`, `catalog_id='services'`); code imports from `lib/services/index.ts`. `createSD` auto-sets `service_type_entry_id`.

## How it's built
### Key functions / files
- `lib/operations/activation.ts` → `activateService()` — the top-level "payment confirmed → spin up the client" orchestrator.
- `lib/operations/service-delivery.ts` → `createSD()` (central SD creator), `advanceStage()`, `completeSD()`.
- `lib/operations/ein-received.ts` → `triggerEINReceivedWorkflow()` — the EIN→active hand-off.
- `lib/operations/sync-tier.ts` → `syncTier()` — the ONLY legal tier writer (R102).
- `lib/portal/auto-create.ts` → `tierForContract()`, ensures a minimal CRM account for formation clients.
- `lib/mcp/tools/formation.ts` → `formation_form_create/get/review`, `formation_confirm`. Related: `member_info_form_*`, `ss4_*` (MMLLC EIN docs).
- UI: `app/formation-form`, CRM "Record EIN Received" button.

### What `createSD` does (every SD, not just formation)
Resolves the first pipeline stage for the service type; propagates `is_test` from the account/contact; resolves `service_type_entry_id` from the catalog; inserts `service_deliveries`; then **fires `dispatchWorkflowForSdCreated`** (the workflow engine hook — fire-and-forget). ITIN SDs are forced to contact-only (account_id=null).

### Tables
`service_deliveries`, `service_delivery_stage_history`, `accounts` (`portal_tier`, `status`, EIN), `contacts`, `account_contacts`, `pipeline_stages`/catalog, `leads`, `pending_activations`, `jobs` (welcome package), `action_log`.

## Gotchas, invariants & past bugs
- **Never advance tier by hand or write `portal_tier` directly** (R102) — EIN→active happens only through the EIN-received workflow / `syncTier`.
- **Materialization forces `formation` tier with `allowDowngrade: true`.** `accounts.portal_tier` **defaults to `'active'`** at insert, so a plain `syncTier('formation')` is treated as a downgrade and silently no-ops — leaving a just-formed company wrongly at `active`. `formation-materialize.ts` passes `allowDowngrade: true` so the new account becomes `formation`. Safe because materialization always runs **before** the EIN exists and the `already_materialized` guard blocks re-runs on an account that has since gone active. The contact-tier cascade still uses `computeContactTier` (MAX across the contact's accounts), so a returning client who already owns an active company keeps their `active` contact tier — only the new company's account row is `formation`.
- **MMLLC nuance:** the `ein-received.ts` helper **intentionally excludes** the MMLLC member-info portal-message flow, so silent inline EIN edits don't auto-message clients. MMLLC clients must be promoted via the explicit "Record EIN Received" button, which includes that messaging.
- **`createSD` fires the workflow dispatcher** (sd_created trigger) fire-and-forget in a try/catch — a workflow failure won't block SD creation, but check the dispatch result/logs if an expected follow-up didn't spawn.
- **Shared "Closing" stage:** the Closure system shares stage names with formation; any stage migration must scope `service_type='Company Formation'` only.
- **⚠️ In-flight redesign (NOT shipped):** "Flexible Formation Lifecycle" (formation ends at EIN=active, banking/lease decoupled, OA self-service) is on branch `feat/flexible-formation-lifecycle` (dev_task `cdc79f20`), planned + audited but **not built**. Do not assume the redesigned behaviour in current production — verify against the code above.

## How to verify current state
- Read `lib/operations/ein-received.ts` (the canonical EIN→active steps), `activation.ts` (`activateService`), `service-delivery.ts` (`createSD`).
- A client's formation SD: `SELECT id, stage, status, account_id, contact_id FROM service_deliveries WHERE service_type='Company Formation' AND (account_id='<account_id>' OR (account_id IS NULL AND contact_id='<contact_id>'));` — in-flight formations are contact-scoped (`account_id IS NULL`), materialized formations are account-scoped.
- Tier logic: `lib/operations/sync-tier.ts` + `tierForContract` in `lib/portal/auto-create.ts`.
- Pipeline stages for Company Formation: query `pipeline_stages` / the services catalog.
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
