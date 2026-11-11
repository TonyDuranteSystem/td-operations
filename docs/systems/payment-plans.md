# Payment plans (a setup fee paid in parts) and the Calendar's "Invoices to raise"
_Last verified against code: 2026-11-11 — Claude (dev job `ae3c19db`, SANDBOX, in a pull request). **Nothing raises or emails a later part by itself any more.** The daily job `/api/cron/plan-part-auto-raise` (it raised AND emailed date parts, 2026-08-27 → 2026-11-11; it sent exactly one invoice in its life, Tosello part 2 on 2026-09-23) is REMOVED (route, `vercel.json`, `lib/cron-coverage.ts`, `duePartsToAutoRaise`). A later part is raised by a person, from the Calendar's **Invoices to raise** tab. Antonio's words: "I want nothing automatic, but when it's time in the calendar there will be an invoice to raise… that will blink red"; "the invoice must be under the contact where it came from originally, not the company"._

## What it is
An offer can be paid in parts (`offers.payment_plan`, a list; production on 2026-11-11: 3 of 273 offers). Part 1 is invoiced AT SIGNING (the activation anchor). Every later part is invoiced when a person decides it is time — the Calendar tells them.

## Business rules
- **A plan part = `{ seq, amount, currency, trigger }`.** One currency per plan; the parts add up to the offer's gross (±0.01); numbered 1..N; exactly one `signing` part. Authority: `lib/offers/payment-plan.ts` (`validatePaymentPlan`).
- **Triggers (what makes a later part DUE on the Calendar):**
  - `date` — the day arrives (due that day; stays due, "N days late", until raised).
  - `step` — **"when a step is reached"** (2026-11-11): `{ service_type, stage, label }`, e.g. Company Formation → EIN Received ("when the EIN arrives"). Due when the offer's job for that service has reached that step (its own step number is the target's or later, or it is completed). Read from the job, nothing dispatches. Offered in the offer builder only for services whose job carries the offer (`service_deliveries.source_offer_token`): `STEP_TRIGGER_SERVICE_TYPES` in `lib/plan-invoices/steps.ts` = Company Formation, ITIN (production, jobs of the last 120 days at 2026-11-11: formation 16/19 tied, ITIN 11/19, closure 2/16, the rest 0 — add a service there ONLY after checking its job carries the token).
  - `manual` ("When you say so") — never due by itself; listed under "Coming up" with the client-visible reason and a "Raise now" button.
  - `event` — still refused (`WIRED_TRANCHE_EVENTS` is empty); `step` is the supported way to wait on a moment.
- **`label` is CLIENT-VISIBLE** (it reads "Part 2 of 2, due <label>"). The builder pre-fills a sentence for a step (`defaultStepWording`: EIN → "after the EIN arrives") and never overwrites the author's own words.
- **WHO PAYS = the offer's own "Invoice to"** (`offers.bill_to`, `lib/offers/bill-to.ts::resolveInvoiceTarget`): `person` → the contact who signed, no company; `company` → the chosen company; `entity` → a billing entity. The company the offer is LATER linked to (formation materialization) never changes the payer. Every Calendar row names the payer.
- **Raise = create AND send, on a click** (`lib/plan-invoices/raise.ts::raiseAndSendPlanPart`, route `POST /api/crm/admin-actions/raise-plan-part`, staff only, body = offer token + part number only): `createTDInvoice` (idempotency key `offer-tranche:TOKEN:SEQ` + the unique index `uq_payments_one_invoice_per_tranche`, lineage columns `tranche_offer_token` / `tranche_seq`, `payment_category = 'setup_tranche'`, the offer's card-fee rate) then `sendTDInvoice` for a new Draft. A part already raised as a Draft is only sent; a part already sent/paid is refused with the invoice number. The amount is the plan's, never typed. Logged in `action_log` (`plan_part_raised_from_calendar`).
- **The account-page "Raise invoice"** (`PaymentPlanPartsSection`, `components/accounts/account-detail.tsx`) still exists; it makes a DRAFT on the COMPANY — wrong for an offer billed to a person. Prefer the Calendar.

## How it's built
- **Calendar tab** `?tab=invoices` (`components/plan-invoices/invoices-to-raise-tab.tsx` + `raise-button.tsx`; list read by `lib/plan-invoices/load.ts::loadInvoicesToRaise`; pure rule `classify.ts::classifyPlanPart`; types `types.ts`). Due rows are red and BLINK (`animate-pulse`, steady red with reduced motion); the tab shows a red count on EVERY Calendar tab, and the left-menu Calendar item shows the same number (`/api/dashboard/badges` → `invoicesToRaise`, `components/dashboard/sidebar.tsx`). Only SIGNED / COMPLETED offers are read. A part with a live invoice is not listed; a Draft IS (it must be sent).
- **Offer builder** (`components/offers/create-offer-dialog.tsx`): per later part "When is it due?" = When you say so / On a date / When a step is reached (steps from `GET /api/crm/offer-plan-steps?services=…`, staff only, under `/api/crm` because `/api/offers` is public).
- **Existing machinery reused, not rebuilt:** `planStatusForOffer` / `computePlanStatus` / `isRaisable` (`lib/offers/payment-plan-state.ts`), `invoiceTargetForOffer`, `createTDInvoice`, `sendTDInvoice`.

## Gotchas, invariants & past bugs
- The offer builder used to say "nothing invoices itself — a date is a reminder, not a scheduler" while the daily job raised AND emailed date parts. The words and the system now agree.
- The Calendar's own components stay free of `fetch` and data modules (pinned by `tests/unit/new-calendar-wiring.test.ts`): the writing UI lives in `components/plan-invoices/`, the shapes in `lib/plan-invoices/types.ts`.
- With the job gone, a part nobody raises never goes out. That is the choice Antonio made; the red count on the Calendar is the only nudge.
- A part waiting on a step whose name no longer exists in the step settings is shown with a warning, never silently dropped (`stepNotFound`).
- Production state 2026-11-11: `gabriel-contra-2026` part 2 was authored as `manual — "After the EIN arrives"` (it would never have turned red); `carasso-consulting-llc-2026` is a DRAFT with part 2 dated 2026-11-27 (before this change it would have been auto-sent on signing + that date).

## How to verify current state
- Plan offers: `SELECT token, status, payment_plan FROM offers WHERE payment_plan IS NOT NULL`.
- Raised parts: `SELECT invoice_number, invoice_status, tranche_offer_token, tranche_seq, contact_id, account_id FROM payments WHERE tranche_offer_token IS NOT NULL`.
- Open the Calendar → "Invoices to raise"; tests: `tests/unit/plan-invoices-classify.test.ts`, `plan-invoices-load-raise.test.ts`, `invoices-to-raise-wiring.test.ts`, `payment-plan-state.test.ts`.
- The morning job is gone: `vercel.json` has no `plan-part-auto-raise`.
