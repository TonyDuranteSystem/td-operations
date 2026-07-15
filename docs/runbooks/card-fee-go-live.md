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

## Step 2 — deploy the code with the fee turned OFF
- **Turn the fee OFF before the code deploy** — set
  `app_settings.payment_fee_config.enabled = false`. This is critical: the moment the
  code is live with the flag ON, the VERY NEXT card payment from ANY client gets the
  fee, watched or not. Deploying OFF means organic traffic can't become your first
  involuntary test subject.
- Confirm the flag is reachable and flips in ONE action, no redeploy (set it back to
  `true` to arm). It OVERRIDES every per-deal 5% pin → OFF charges the BASE. (Proven
  in sandbox: `resolveChargeRate` returns 0 when off, the pin when on.)
- **Confirm the NAMED watcher has DIRECT access to the flag NOW** — not "ask a
  developer during the incident." The abort is only real if the watcher can flip it in
  seconds. Verify this before Step 3, not during it.

## Step 3 — arm, then drive the FIRST real card charge (chosen, not random)
- Pick a SMALL, KNOWN, friendly client for the first live card payment. Low-stakes by
  design. Do not let the first live fire be a large or unknown transaction.
- One NAMED person watches it (write the name here before go-live): __________.
- **Sequence so the chosen client is provably first:** with the watcher live and ready,
  flip the flag ON, then immediately drive the chosen friendly charge — OR deploy in a
  low-traffic window and run it at once. The first fee-bearing charge must be the one
  you're watching, not the first organic payment to arrive.

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
