# Partners & Team Access
_Last verified against code: 2026-06-25d — Claude (PARTNER DEAL — Slice 3 IN PROGRESS, branch `feat/partner-deal-config`, SANDBOX. Goal: a partner-portal "My Referrals" page where the partner sees each referred client's progress and self-serves the payout request. **Flexibility (Antonio): a referral can be an INDIVIDUAL (contact) OR a COMPANY (account)** — payouts now anchor on the **OFFER** (universal), not the account. Migration `20260625-2300-partner-payout-request.sql` (sandbox-applied): `referral_payouts` += `offer_token`, `account_id`, `contact_id`, `payout_request` jsonb (USD bank details), `invoice_url`/`invoice_name`, `requested_at`; `status` gains `'requested'` (pending→requested→approved→paid). **CRM to-do task REMOVED** from both setup (Step 3.6) + renewal payouts — the partner self-serves instead (staff still approve/pay in CRM → Partners). Both payout inserts now stamp offer_token/account_id/contact_id. **Progress logic** pure `lib/portal/partner-referrals.ts::computeReferralProgress` — derived ENTIRELY from CRM/Finance state, no manual flags: Call done (call_summaries) → Offer sent/Client signed (offer.status) → Client paid (status=completed OR setup payout auto-created from Finance) → Annual renewal (renewal payout); monotonic; `isPayoutRequestable` (pending). 8 unit tests. **STILL TO BUILD**: the partner-portal page itself (app/portal/partner/referrals) + the request form (bank details + optional invoice upload) + server action + sidebar nav + referral_payouts type additions; then push + QA. Full dev_task tracks the plan. NOTE: 'no manual confirm' — the system catches the payment from Finance (bank-feed/activation) and auto-creates the pending payout.)_
_Last verified against code: 2026-06-25 — Claude (PARTNER DEAL CONFIG, branch `feat/partner-deal-config`, SANDBOX. A managed partner can sell a TD service at a custom price with a custom split: a **setup share** (one-time, paid at activation) + a **renewal share** (recurring, each year the client renews). Decisions (Antonio 2026-06-25): per-SALE terms, partner paid by **bank-transfer payout record** (referral_payouts, status pending → approve/pay in CRM → Partners), renewal **indefinite**, all payouts **USD** (clients pay EUR, payouts USD, figure taken directly, no FX). **No new tables** — reuses `accounts.partner_id` (link) + `referral_payouts`. Added: `accounts.partner_deal` jsonb `{setup_payout, renewal_payout, currency, offer_token}` + `offers.partner_renewal_payout` numeric (migration `20260625-2100-partner-deal-config.sql`, sandbox-applied, NOT yet prod). **Setup payout** reuses the existing Step 3.6 flat_fee path (now USD, was hardcoded EUR). **Persistence**: activation Step 3.6 sets `accounts.partner_id` + `accounts.partner_deal` (buildPartnerDeal). **Renewal payout (Slice 2)**: `installment-handler.ts onFirstInstallmentPaid` pays the renewal share once/year, gated by pure `shouldPayRenewal` to years AFTER formation (formation year = setup payout only — no double-pay), idempotent per (account, year) via `reference='renewal:<acct>:<year>'`. **Double-pay guard**: `shouldRunReferralCredit` — the referral auto-credit (activate Step 3.5) SKIPS when the offer has a `partner_id`. **UI**: admin Create Offer dialog `components/offers/create-offer-dialog.tsx` has an optional Partner deal section (picker + setup/renewal $); `createOffer` + `create-offer` route thread partner fields; `partner-actions` gained a `list` action. Pure helpers in `lib/partners/partner-deal.ts` (buildPartnerDeal/parsePartnerDeal/shouldPayRenewal/shouldRunReferralCredit), 16 unit tests. NOTE: gen:types targets prod + CLI offline, so the two new columns were hand-added to lib/database.types.ts; they'll match once the migration is promoted to prod.)_
_Prior: 2026-05-29 — Claude (read lib/partners/payout-calc.ts, portal_team_send in portal.ts)_

## What it is
Three distinct things that share the word "team" / "partner" — keep them separate:
1. **Partner relationships & payouts** (built) — external partners who refer clients under a commission model; TD computes and pays their commission.
2. **Internal team messaging** (built) — `portal_team_send`: staff-only notes, NOT client-visible.
3. **Portal Team Access** (PLANNED, not built) — letting a client *owner* invite their *employees* into the company portal.

## 1. Partner payouts (built)
- `calculatePartnerPayout()` (`lib/partners/payout-calc.ts`, pure) computes what a partner is owed for one confirmed payment. Called from `activate-service` Step 3.6 when an offer has `partner_id` and `partner_payout_model != 'none'` and payment is confirmed. **The transaction is the source of truth, not the partner type** — the caller passes the per-transaction model + rate.
- **Models** (`PayoutModel`): `none`, `price_difference` (`paymentAmount − tdBaseCost`, clamped ≥0; needs `client_partners.td_base_costs[service_slug]`), `percentage` (rate as fraction `0.10`, or whole `10` auto-÷100), `flat_fee` (absolute EUR), `credit_note` (absolute EUR, added to next partner invoice).
- **All amounts EUR** — the caller does USD→EUR FX before calling.
- Returns `{ amount, model, error?, note? }` — on a problem (`missing_base_cost` / `missing_rate` / `negative_result` / `model_none`) it returns `error` **instead of throwing**, so the caller writes `status='manual_review'` rather than crashing.
- Partner data: `client_partners` (`td_base_costs`, commission model, price list); payouts/referrals shared with `referrals-circleback.md` (`referrals`, `referral_payouts`).
- **Partner portal**: `app/portal/partner/{clients,invoices,new-request}` — a partner sees their managed clients + invoices and can submit new requests. CRM view: `app/(dashboard)/partners`.

## 2. Internal team messaging (built)
- `portal_team_send` (`lib/mcp/tools/portal.ts`) — an **internal staff-only** message linked to an account/contact, shown in CRM **Portal Chats → Team tab**; staff get real-time toast + push. **Never visible to clients.** Use it to flag things for Luca etc. (This is staff coordination — distinct from the client-facing portal chat in `portal.md`.)

## 3. Portal Team Access (PLANNED — NOT built)
- Design goal: a client **owner** (SMLLC owner contact / MMLLC SS-4 signer) invites **employees** into ONE company's portal with per-section permission toggles (data-driven, server-enforced, default-deny). Non-delegable: signing legal docs (view-only for teammates) + team management.
- Architecture (Option B): an **independent `portal_team_members` table**; teammates auth as `role='client'` with markers; a `resolvePortalIdentity` seam; teammates are NOT contacts and NOT in `account_contacts` (so they're invisible to billing/ops).
- **Status: design FINAL, NOT built** — dev_task `4cf522c1`, design sysdoc `portal-team-access-design`. **Do not assume any of it exists in production** until verified.

## Business rules
- **Partner payout is per-transaction** and **EUR-denominated**; `price_difference` is clamped to ≥0; a missing base cost → `manual_review`, never a silent 0.
- **`portal_team_send` is staff-only** — never surfaces to a client.
- **Portal Team Access is not live** — verify dev_task `4cf522c1` before acting on anything teammate-related.

## How it's built — key files & tables
- Files: `lib/partners/payout-calc.ts`, `lib/operations/activation.ts` (Step 3.6 caller), `lib/mcp/tools/portal.ts` (`portal_team_send`), `app/(dashboard)/partners`, `app/portal/partner/*`. Planned: per `portal-team-access-design`.
- Tables: `client_partners`, `referrals`, `referral_payouts`, `payments` (partner invoices), `portal_messages` (the internal team thread). Planned: `portal_team_members`.

## Gotchas, invariants & past bugs
- **"Team" is overloaded** — `portal_team_send` = internal staff messaging (built); Portal Team Access = client employees (NOT built). Don't conflate them.
- **`calculatePartnerPayout` never throws** — it returns an `error` field; the caller must handle `manual_review` / skip. Treating `amount: null` as `0` would underpay a partner.
- **`price_difference` needs `td_base_costs[service]`** — if absent, it's `manual_review`, not a zero payout.
- **FX is the caller's job** — the helper assumes EUR; passing a USD amount silently mis-pays.

## How to verify current state
- Read `lib/partners/payout-calc.ts` (the models + error returns) and `lib/operations/activation.ts` (the Step 3.6 call site).
- Confirm Team Access status: `dev_task_list` for `4cf522c1` / sysdoc `portal-team-access-design` — and check whether a `portal_team_members` table actually exists before assuming the feature is live.
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
