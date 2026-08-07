# CRM Core — Accounts, Contacts, Tasks, Deals
_Last verified against code: 2026-08-06 — Claude (`crm_dashboard_stats` gained a "Portal App Adoption" section (Phase 2 of dev job `8f38add1`): % of active accounts receiving push derived live from `push_subscriptions` + a 30-day install funnel from `pwa_events`, via `lib/portal/pwa-stats.ts::getPwaAdoptionStats`. Additive and failure-isolated — the stats call is wrapped in its own try/catch, so a pwa-stats failure never breaks the business snapshot. States the iOS attribution caveat in its output. Full subsystem detail: `pwa.md`.)_
_Prior: 2026-07-17 — Claude (crm_update_record's mark-Paid installment hook now takes the renewal year from the PAYMENT ROW's `year` column (wall-clock fallback only when NULL) before firing onFirst/onSecondInstallmentPaid — a prior-year installment marked Paid in January no longer fires the handlers for the wrong season. Part of the renewal-chain tax-record fix; full detail in tax-returns.md 2026-07-17b.)_
_Prior: 2026-07-08 — Claude (cross-tab live updates: `lib/operations/task.ts` `createWorkflowTask`/`updateTask` now fire `emitUiEvent('tasks')` (`lib/ui-events.ts` → `ui_events` table → supabase_realtime → `components/dashboard/ui-event-listener.tsx`) after a successful write, so every open dashboard tab/machine refreshes task views immediately. Best-effort/fire-and-forget — task semantics unchanged. NOTE: the quick-create route `app/api/tasks/route.ts` still does a RAW tasks insert (pre-existing P2.4 lint debt, intentionally NOT touched — it does not emit; migrating it through createWorkflowTask/a create helper is the flagged fix).)_
_Prior: 2026-06-15 — Claude (contact email → portal LOGIN email auto-sync: changing a contact's email via crm_update_record, the core updateContact, OR the inline contact/account email field now also updates that client's portal login email, through the shared `lib/operations/portal-login-email.ts` helper — resolves the login by contact_id, conflict-guarded, notifies the client. See auth-oauth.md.)_
_Prior: 2026-05-29 — Claude (read lib/mcp/tools/crm.ts, lib/operations/contact.ts, per-record-activity)_

## What it is
The foundational records everything else hangs off: **accounts** (companies), **contacts** (people), the **`account_contacts`** junction that links them, plus **tasks**, **deals**, **leads**, **payments**, and **service_deliveries**. Almost every other system references these.

## The account ↔ contact model (the thing to internalize)
- A **contact** (person) and an **account** (company) are linked **many-to-many** through `account_contacts` (`role`, `is_primary`). **One person can own several LLCs with completely different names; one LLC can have several contacts.**
- `crm_search_contacts` returns a contact **with all their linked accounts** (`account_contacts(account_id, role, accounts(company_name, status, …))`) — so when a client messages, search by name first, then act per account.
- A contact's `portal_tier` is computed as the max across their accounts (see `portal.md`); a contact with no account keeps their own tier.

## The canonical write path (R018)
- **Never use `execute_sql` to write CRM data — always `crm_update_record`** (R018), or the per-table operation-authority helpers.
- `crm_update_record` (`lib/mcp/tools/crm.ts`) validates status/stage against `STATUS_VALIDATION_MAP` (ENUM-backed tables: `accounts.status`, `payments.status`, `tasks.status`, `leads.status`, `deals.stage`, `tax_returns.status` — constants in `lib/constants.ts`), writes the change, logs to `action_log`, and mirrors to Airtable (`syncSupabaseToAirtable`).
- **Operation-authority layers** — `updateAccount` / `updateTask` / `updateContact` (`lib/operations/contact.ts` etc.) are single-entry helpers that add optimistic locking + `action_log` audit. The **P2.4 ESLint rule blocks raw `.insert/.update/.upsert` on protected tables** — go through these helpers (workflow handlers and the AI agent already do).
- **Contact email is kept in sync with the portal LOGIN email.** Changing a contact's `email` (via `crm_update_record`, `updateContact`, or the inline contact/account email field) calls `syncPortalLoginEmail` (`lib/operations/portal-login-email.ts`): it finds the client's login **by `contact_id`** (never by email), and if the new email is free, updates the login and emails the client their new login (password unchanged). If the new email already belongs to **another** login it is a **conflict** — the contact email still updates but the login is left unchanged and flagged (never merges identities). Best-effort: a sync failure never blocks the contact update. This closes the historical drift where a contact's email changed but the login kept the old address.

## How it's built
### Tools (`lib/mcp/tools/crm.ts`)
`crm_search_accounts`, `crm_search_contacts`, `crm_search_deals`, `crm_search_payments`, `crm_search_services`, `crm_search_tasks`, `crm_get_client_summary` (the full 360 view — accounts + services + payments + tasks + tax + conversations + referrals), `crm_dashboard_stats`, `crm_update_record`, `crm_sync_airtable`.

### Key files
- `lib/mcp/tools/crm.ts` — search + `crm_update_record` + `STATUS_VALIDATION_MAP` / `validateStatusField`.
- `lib/operations/{contact,task,account}.ts` — write-authority layers (optimistic lock + audit).
- `lib/per-record-activity/queries.ts` — `getAccountBackendActivity` / `getContactBackendActivity` / `summarizeActivity` (backend activity timeline per record).
- `lib/constants.ts` — the status/stage enums. `lib/sync-airtable.ts` — the mirror. `lib/mcp/action-log.ts` — audit.
- CRM pages: `app/(dashboard)/{accounts,contacts,deals,tasks,leads,...}`.

### Tables
`accounts`, `contacts`, `account_contacts` (junction: `role`, `is_primary`), `tasks`, `deals`, `leads`, `payments`, `service_deliveries`, `conversations`, `action_log`. Contact-identity extras (Contact Identity project): `contacts.alt_emails` / `merged_into`, `contact_merge_log`, `merge_contacts()` DB function.

## Gotchas, invariants & past bugs
- **A person can own multiple LLCs under different names** — always search by a broad name root, try spelling/nickname variants, and check ALL linked accounts before saying "not in the system."
- **R018:** CRM writes go through `crm_update_record` / the authority helpers, never `execute_sql`. Raw writes to protected tables are blocked by ESLint (P2.4).
- **Status validation covers only ENUM-backed tables** (accounts/payments/tasks/leads/deals/tax_returns) — other fields aren't enum-checked.
- **Supabase is the source of truth; Airtable is a downstream mirror** — never treat Airtable as authoritative.
- **Contact merge is delicate** — `merge_contacts()` must repoint `auth.users.contact_id` and dedupe; the Contact Identity hardening is in progress (some machinery on prod is inert). Verify before merging.

## How to verify current state
- Read `lib/mcp/tools/crm.ts` (`STATUS_VALIDATION_MAP`, `crm_update_record`, the `crm_search_contacts` account join) and `lib/operations/contact.ts` (the authority pattern).
- A contact's companies: `SELECT ac.account_id, ac.role, a.company_name FROM account_contacts ac JOIN accounts a ON a.id=ac.account_id WHERE ac.contact_id='<id>';`
- Allowed status values: read the constants in `lib/constants.ts`.
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
