# Go-live runbook — Card processing fee (dev_task 6ec6872a)

The card fee (5%) is built, sandbox-QA'd, and supervisor-approved. This is the
launch-time checklist. Follow it in order. Do NOT skip the abort criteria.

Branch: `claude/card-fee-charge-6ec6872a`. Migration: `scripts/migrations/20260715-1200-card-fee-charge.sql`.

## Before anything — Antonio's explicit "ship it" is required.

## Step 0 — the database change goes FIRST, while old code is still live
- Antonio runs the migration in the Supabase **production** dashboard BEFORE the code
  deploys (prod DDL is Antonio-run; `execute_sql` blocks DDL).
- **Verified additive-only / backward-compatible:** it only ADDS columns
  (`offers.card_fee_rate`, `payments.card_fee_rate`, `payments.card_fee_amount`,
  `payment_items.item_type` with `NOT NULL DEFAULT 'service'`), a partial unique index
  on `item_type='fee'` (old code never writes a fee line, so it never bites), a 5%
  backfill, and the `payment_fee_config` app-setting. The OLD (fee-less) code
  references none of these, so the window between DDL and deploy is harmless.

## Step 1 — the pre-ship PRICE SWEEP (run LAST, right before the code deploy)
- Re-run the old-vs-new price comparison across ALL live offers + open invoices.
- Proposals change daily, so this only counts if run immediately before shipping.
- PASS = no real client's price moves unexpectedly. If any moves → STOP, investigate.

## Step 2 — deploy the code, then verify the kill switch is reachable
- After deploy, confirm you can flip the fee OFF in ONE action, no redeploy:
  set `app_settings.payment_fee_config.enabled = false`. This OVERRIDES every per-deal
  5% pin → checkout charges the BASE. Set it back to `true` to re-arm.
  (Proven in sandbox: `resolveChargeRate` returns 0 when off, the pin when on.)

## Step 3 — the FIRST real card charge is chosen, not random
- Pick a SMALL, KNOWN, friendly client for the first live card payment. Low-stakes by
  design. Do not let the first live fire be a large or unknown transaction.
- One NAMED person watches it (write the name here before go-live): __________.

## Step 4 — the first-charge PASS/FAIL is ONE number, decided up front
PASS only if all three reconcile:
  card-captured amount  ==  invoice total  ==  base × 1.05
Check on the invoice after the payment: `total` = `amount_paid`, `card_fee_amount` =
`total − base`, exactly one fee line. Anything else = FAIL → abort (Step 5).
Do NOT let a second card payment flow until the first PASSES.

## Step 5 — abort path (if the first charge is wrong)
1. **Stop the second charge immediately:** flip the kill switch OFF
   (`payment_fee_config.enabled = false`). Fee stops everywhere, no redeploy.
2. **Make the one affected client whole by hand:** issue a manual credit note
   (Finance → the existing `createCreditNote` path). There is NO auto-refund — a
   NAMED person does this (write the name here): __________.
3. Diagnose against the sandbox harness (`tests/live/card-fee-money-path.test.ts`),
   fix, re-deploy, re-arm the switch, and repeat Step 3 with a fresh low-stakes charge.

## Deferred — do NOT ship these in the first release
- The CRM screen to EDIT the rate, and driving the "+5%" contract wording from the
  pinned rate, ship together as a GATED pair. Until then the rate stays 5% everywhere
  (display == charge, no drift) and **the rate-editor must not be exposed** — a 7%
  charge against a 5% contract is the failure that pairing prevents.

## Reference
- Mechanism + money invariants + the "no auto-refund" assumption: `docs/systems/billing-invoicing.md`.
- Charge + pin: `docs/systems/offers.md`.
- The money-path proof (what "correct" looks like): the live harness above (9/9 green vs sandbox DB).
