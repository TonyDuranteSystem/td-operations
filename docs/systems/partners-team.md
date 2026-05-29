# Partners & Team Access
_Last verified against code: 2026-05-29 — Claude (read lib/partners/payout-calc.ts, portal_team_send in portal.ts)_

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
