# Onboarding
_Last verified against code: 2026-05-29 — Claude (read lib/mcp/tools/onboarding.ts, onboarding-form-completed route)_

## What it is
The flow for clients who **already have an LLC** and are signing up for ongoing management services — as opposed to formation (creating a new LLC). It collects the client's company data via a form, reviews it, and promotes the client to the `active` tier. It deliberately mirrors the formation form pattern.

## Lifecycle
1. **Signed + paid for an onboarding contract** → account lands at tier **`onboarding`** (`tierForContract('onboarding')`).
2. **Onboarding form created** — `onboarding_form_create` pre-fills owner info from the lead, sets entity type (SMLLC/MMLLC) + state as metadata, returns `${APP_BASE_URL}/onboarding-form/{token}/{access_code}`. Admin preview: `?preview=td` (R035 — always review before sending).
3. **Client submits** → `app/api/onboarding-form-completed/route.ts` (fires the workflow dispatcher; see `workflow-engine.md`).
4. **Staff reviews** — `onboarding_form_review` validates the data, writes account fields (e.g. sets `ra_renewal_date` to today = the RA-change date), and **upgrades the tier `onboarding → active`** via `syncTier` ("onboarding review completed"). The client now has full portal access.

## Business rules
- **Onboarding = existing LLC** (no formation/EIN step) — the key difference from formation, which creates the company and advances tier on EIN.
- **R102** — tier moves only through `syncTier()`; onboarding → active happens at review, never manually.
- **R035** — always provide/review the `?preview=td` link before sending a form to a client.

## How it's built
### Tools & files
- `lib/mcp/tools/onboarding.ts` — `onboarding_form_create`, `onboarding_form_get`, `onboarding_form_review`, `onboarding_setup`, `onboarding_submission(s)`.
- `lib/mcp/tools/member-info.ts` — `member_info_form_create`, `member_info_requests` (MMLLC member-info collection).
- `lib/mcp/tools/welcome-package.ts` — `welcome_package_prepare` (shared with the formation EIN hand-off).
- Routes: `app/api/onboarding-form-completed/route.ts`, `app/api/portal/onboarding-complete/route.ts`. Form: `app/onboarding-form`.
- Tier: `lib/operations/sync-tier.ts`.

### Tables
Onboarding form submissions, `accounts` (`portal_tier`, `ra_renewal_date`), `leads`, `service_deliveries`, `jobs` (welcome package).

## Gotchas, invariants & past bugs
- **Don't confuse with formation.** Onboarding clients already have an EIN/LLC; the tier path is `onboarding → active` (at form review), not `formation → active` (at EIN).
- **`onboarding_form_review` sets `ra_renewal_date = today`** (treats onboarding as the RA-change date) — onboarding-specific behaviour; the renewal cron then tracks from here.
- **Tier upgrade is via `syncTier` only** (R102) — the review tool calls it; don't set tier by hand.
- Shares the welcome-package job + form infrastructure with formation — changes there affect both.

## How to verify current state
- Read `lib/mcp/tools/onboarding.ts` (`onboarding_form_review` — the account-field writes + `syncTier` to active) and `app/api/onboarding-form-completed/route.ts`.
- A client's onboarding state: check `accounts.portal_tier` + the onboarding submission row.
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
