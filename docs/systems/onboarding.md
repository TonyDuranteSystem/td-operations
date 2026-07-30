# Onboarding
_2026-07-30 — Claude (**RA-renewal date derivation fixed (plan c2d97552).** The MCP review tool (`lib/mcp/tools/onboarding.ts`) previously wrote `ra_renewal_date = TODAY` unconditionally on every review run — that date sat inside the RA cron's 30-day window, so a just-onboarded client got a State RA Renewal SD a year early, and re-runs clobbered any correct date already on the account. Now: the review is treated as the RA-CHANGE moment — it records `accounts.ra_switch_date = today` (null-only on re-runs; billing derives the TD-start from it) and fills `ra_renewal_date` as the ANNIVERSARY (+1yr) via the shared engine `lib/operations/renewal-dates.ts` (fill-if-null, per-column guards; also derives AR-by-state + CMRA and mirrors the deadlines rows the portal reads). The onboarding-setup job's step 5b now routes through the same engine — same null-only semantics as before, plus the RA date it historically never set. Details in `compliance-renewals.md` (2026-07-30).)_
_Prior: 2026-07-23 — Claude (**Clients were being chased for months to complete forms they had already finished.** Three faults in the wizard-reminder cron, all measured on production. **(1) The completion guard was blind to exactly the rows it existed for.** Its first line was `if (!w.account_id) return false` — "cannot tell, keep reminding". But a wizard row often has NO account (started before the company existed, or a stray second copy), and those are precisely the ones that go stale. Filippo Bernardini submitted his Formation form in April, a second unlinked copy was created in May, and he received **45 reminders — 22 for that one stale form**. Michele Cotti and Alessandro Federici the same. Fixed by resolving the CONTACT's accounts when the wizard has none and running the identical check against those: it widens how the account is FOUND, it does not weaken what is checked. **(2) The "7-day" reminder was not a 7-day reminder.** Both levels used a flat 2-day lookback and there was no cap, so once a form passed 7 days old it re-fired every 2-3 days indefinitely. Now genuinely weekly, capped at 4 — safe to stop because the 7d branch already opens a staff task, so a stuck client is followed up by a human rather than an endless drip. **(3) The dedupe was keyed by CLIENT, not by FORM.** It asked "did this account/contact get any reminder of this level recently" — so a client with several in-progress forms had them dedupe against each other, and because a wizard WITH an account dedupes on account_id while one WITHOUT dedupes on contact_id, two different keys produced two notifications per run. Now keyed on the notification title, which encodes form type + company. **THE RULE THAT ALMOST SHIPPED AND WAS WRONG:** "if they already submitted this form type, stop". Checked against production before building on it — 8 clients legitimately submit the TAX form repeatedly (once a year) and 1 did formation twice for a second company. That rule would have silenced real reminders. The shipped rule is "formation is done when EVERY linked company has a formation date" — a second company still forming keeps its reminder. Pure rules extracted to `lib/portal/wizard-reminder-rules.ts` and unit-tested, including the second-company case. **No data cleanup was needed:** the cron already auto-closes wizards it detects as complete, so the fix cleans up after itself on the next run — Filippo, Alessandro and Michele's stale forms close automatically. Uxio Test's banking form is correctly left alone: banking has no canonical completion signal.)_
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
