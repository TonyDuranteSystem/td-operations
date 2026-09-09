/**
 * CRON: Card-autopay auto-charge — Phase 1 (dev job 10995181).
 *
 * Runs daily. Finds every Sent, unpaid, due invoice — ANY payment type
 * (the January/June annual installments, payment-plan installments,
 * recurring service invoices, one-off invoices — everything except a
 * 'credit' note, which is money TD owes the client, not a charge) — for
 * accounts enrolled in card autopay, and charges the saved card off-session.
 * No client click. Widened from Jan/June-only per Antonio, 2026-08-30: "the
 * autopay must work in any payment they will do."
 *
 * Race safety (the design this cron exists to prove out): EVERY candidate is
 * claimed atomically via lib/operations/autopay-claim.ts BEFORE this cron
 * touches Stripe, so a client's own concurrent "Pay Invoice" click on the
 * same invoice (app/api/workflows/create-invoice-checkout/route.ts) cannot
 * double-charge. If the client already has a live Checkout Session open for
 * this invoice (payments.stripe_checkout_session_id), this cron actively
 * EXPIRES it before charging — Stripe enforces a 30-minute MINIMUM session
 * lifetime, so a DB-only claim cannot close that gap by itself.
 *
 * Failure handling: an off-session charge that needs a live 3DS challenge or
 * is declined releases the claim, creates a staff task, and notifies the
 * client via a portal notification (which the portal-digest cron also
 * emails within 5 minutes) so they can pay manually — never silent.
 */

import { NextRequest, NextResponse } from "next/server"
import StripeConstructor from "stripe"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { getOfficeDateString } from "@/lib/portal/office-hours"
import { isCardAutopayEnabled } from "@/lib/payments/card-autopay-config"
import { claimPaymentForCharge, releasePaymentClaim, holdPaymentClaim, CRON_CLAIM_TTL_MS, AUTOPAY_HOLD_TTL_MS } from "@/lib/operations/autopay-claim"
import { resolveChargeRate } from "@/lib/payments/card-fee-config"
import { computeCardTotal } from "@/lib/payments/card-fee"
import { confirmPayment } from "@/lib/operations/payment"
import { createPortalNotification } from "@/lib/portal/notifications"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"

type StripeClient = ReturnType<typeof StripeConstructor>

let _stripe: StripeClient | null = null
function getStripe(): StripeClient | null {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) return null
    try {
      _stripe = StripeConstructor(key)
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _stripe = new (StripeConstructor as any)(key)
    }
  }
  return _stripe
}

interface Candidate {
  id: string
  account_id: string
  amount: number
  amount_currency: "USD" | "EUR" | null
  invoice_number: string | null
  card_fee_rate: number | string | null
  stripe_checkout_session_id: string | null
  accounts: {
    autopay_stripe_customer_id: string | null
    autopay_stripe_payment_method_id: string | null
  }
}

async function raiseAutopayChargeFailure(
  payment: Candidate,
  reason: string,
  options: { chargeSucceeded?: boolean } = {},
) {
  // dev job 4ca2c691 (full council review 2026-09-09): a card that Stripe
  // already charged successfully needs an ENTIRELY different message than a
  // genuine decline — reusing this task/notification's old wording verbatim
  // for that case would tell staff "charge failed" and "client notified to
  // pay manually" when BOTH are false, which is exactly how a staff member
  // could tell a client to pay twice for something already charged once.
  const chargeSucceeded = options.chargeSucceeded ?? false

  // eslint-disable-next-line no-restricted-syntax -- no consolidated createTask() helper yet (same gap as the pre-existing stripe webhook's task inserts, dev_task 7ebb1e0c); tasks-table writes here follow that established pattern
  await supabaseAdmin.from("tasks").insert({
    task_title: chargeSucceeded
      ? `Autopay charged the card but could NOT be recorded — invoice ${payment.invoice_number || payment.id}`
      : `Autopay charge failed — invoice ${payment.invoice_number || payment.id}`,
    description: chargeSucceeded
      ? `Card autopay successfully charged the client's card, but recording it against the invoice failed or conflicted.\nPayment: ${payment.id}\nReason: ${reason}\n\nThe client's card WAS ALREADY CHARGED — do NOT ask them to pay again. This needs manual reconciliation: confirm the charge against the invoice, or refund it if this turns out to be a genuine duplicate. The client has deliberately NOT been notified about this.`
      : `Card autopay could not charge this invoice automatically.\nPayment: ${payment.id}\nReason: ${reason}\n\nThe client has been notified in the portal. If this keeps happening, consider turning off autopay for this account.`,
    assigned_to: defaultTaskAssignee(),
    priority: "High",
    category: "Payment",
    status: "To Do",
    account_id: payment.account_id,
  })

  if (chargeSucceeded) {
    // The card WAS charged — telling the client to "pay manually" here would
    // risk a real duplicate charge. Silence toward the client is deliberate;
    // the task above is where this gets resolved.
    return
  }

  try {
    await createPortalNotification({
      account_id: payment.account_id,
      type: "invoice",
      title: "Autopay charge failed",
      body: `We couldn't automatically charge your card for invoice ${payment.invoice_number || ""}. Please pay it manually from the Expenses tab.`,
      link: "/portal/invoices?tab=expenses",
    })
  } catch (err) {
    console.error(`[card-autopay-cron] client notification failed for payment ${payment.id}:`, err)
  }
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!(await isCardAutopayEnabled())) {
    return NextResponse.json({ ok: true, message: "Card autopay is off — skipping." })
  }

  const stripe = getStripe()
  if (!stripe) {
    return NextResponse.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 500 })
  }

  const today = getOfficeDateString()
  const results: Array<{ payment_id: string; invoice_number?: string | null; outcome: string }> = []

  try {
    const { data: candidates, error: candErr } = (await supabaseAdmin
      .from("payments")
      .select(
        "id, account_id, amount, amount_currency, invoice_number, card_fee_rate, stripe_checkout_session_id, accounts!inner(autopay_stripe_customer_id, autopay_stripe_payment_method_id)" as never,
      )
      // "Any payment they will do" (Antonio, 2026-08-30) — every invoice type
      // is in scope, EXCEPT 'credit' (a credit note is money TD owes the
      // client, never something to charge a card for).
      .neq("payment_category" as never, "credit")
      .eq("invoice_status" as never, "Sent")
      .not("status", "in", '("Paid","Cancelled","Waived","Refunded")')
      .gt("amount", 0)
      .lte("due_date", today)
      .eq("accounts.autopay_card_enabled" as never, true)) as unknown as {
      data: Candidate[] | null
      error: { message: string } | null
    }

    if (candErr) throw new Error(candErr.message)

    for (const payment of candidates ?? []) {
      const account = payment.accounts
      if (!account?.autopay_stripe_customer_id || !account?.autopay_stripe_payment_method_id) {
        results.push({
          payment_id: payment.id,
          invoice_number: payment.invoice_number,
          outcome: "error: account flagged enabled but missing saved card",
        })
        continue
      }

      const claimed = await claimPaymentForCharge(payment.id, CRON_CLAIM_TTL_MS)
      if (!claimed) {
        results.push({
          payment_id: payment.id,
          invoice_number: payment.invoice_number,
          outcome: "skipped: claim lost to a concurrent charge attempt",
        })
        continue
      }

      // Tracks whether Stripe actually charged the card in THIS attempt, for
      // the catch block below (dev job 4ca2c691, full council review
      // 2026-09-09): an exception thrown AFTER a successful charge — e.g. in
      // bookCardFee, or inside confirmPayment's own installment-handler
      // calls — must never be treated like a genuine decline. Scoped per
      // candidate, reset every loop iteration.
      let chargeSucceeded = false
      let chargedPaymentIntentId: string | undefined

      try {
        // Close the 30-minute-minimum gap: if the client has a live Checkout
        // Session open for this exact invoice, kill it before charging —
        // otherwise they could complete it a moment after we charge here.
        let clientAlreadyPaying = false
        if (payment.stripe_checkout_session_id) {
          try {
            const session = await stripe.checkout.sessions.retrieve(payment.stripe_checkout_session_id)
            if (session.status === "open") {
              await stripe.checkout.sessions.expire(payment.stripe_checkout_session_id)
            } else if (session.status === "complete") {
              // The client beat us to it — their own webhook already settles this.
              clientAlreadyPaying = true
            }
          } catch (sessionErr) {
            console.warn(
              `[card-autopay-cron] session lookup/expire failed for payment ${payment.id} (continuing):`,
              sessionErr,
            )
          }
        }

        if (clientAlreadyPaying) {
          await releasePaymentClaim(payment.id)
          results.push({
            payment_id: payment.id,
            invoice_number: payment.invoice_number,
            outcome: "skipped: client's own checkout session already completed",
          })
          continue
        }

        const cardFeeRate = await resolveChargeRate(payment.card_fee_rate)
        const { cardTotal } = computeCardTotal(payment.amount, cardFeeRate)
        const currency = (payment.amount_currency || "USD").toLowerCase()

        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: Math.round(cardTotal * 100),
            currency,
            customer: account.autopay_stripe_customer_id,
            payment_method: account.autopay_stripe_payment_method_id,
            off_session: true,
            confirm: true,
            metadata: {
              payment_id: payment.id,
              account_id: payment.account_id,
              invoice_number: payment.invoice_number || "",
              source: "card-autopay-cron",
            },
          },
          { idempotencyKey: `card-autopay:${payment.id}` },
        )

        if (paymentIntent.status === "succeeded") {
          chargeSucceeded = true
          chargedPaymentIntentId = paymentIntent.id

          // Book the fee (if any) onto the invoice from the ACTUAL charge
          // BEFORE settling — same sequence the client-paid Checkout path
          // uses (app/api/webhooks/stripe/route.ts).
          const { bookCardFee } = await import("@/lib/finance/card-fee-booking")
          const feeResult = await bookCardFee(payment.id, cardTotal)
          if (feeResult.outcome === "overage") {
            const { raiseCardFeeOverageIssue } = await import("@/lib/finance/card-fee-issues")
            await raiseCardFeeOverageIssue({
              paymentId: payment.id,
              base: feeResult.base,
              charged: cardTotal,
              gatewayPaymentId: paymentIntent.id,
            })
          }

          // dev job 4ca2c691 (full council review 2026-09-09): the result
          // used to be discarded entirely — confirmPayment can legitimately
          // return success:false WITHOUT throwing (a real, non-exceptional
          // write failure or a lost compare-and-swap), which the cron then
          // logged as a plain "charged" success with no record anywhere
          // that the write never landed.
          const confirmResult = await confirmPayment({ payment_id: payment.id, amount_paid: cardTotal, paid_date: today })

          if (confirmResult.success && confirmResult.outcome === "paid") {
            // Clean, verified success — the only case that gets to claim
            // "charged" without qualification.
            await releasePaymentClaim(payment.id)
            results.push({ payment_id: payment.id, invoice_number: payment.invoice_number, outcome: `charged — ${paymentIntent.id}` })
          } else if (confirmResult.outcome === "partial") {
            // Real money moved and was correctly recorded, but didn't cover
            // the full balance (e.g. the invoice total moved between
            // candidate selection and charging). invoice_status flips away
            // from 'Sent' on any partial settlement, so this row naturally
            // stops being a candidate on the next run — safe to release
            // normally, same as any other partial payment in this system.
            await releasePaymentClaim(payment.id)
            results.push({
              payment_id: payment.id,
              invoice_number: payment.invoice_number,
              outcome: `charged-partial — ${paymentIntent.id}`,
            })
          } else {
            // Stripe took the money; our own record of it either failed
            // outright, or the invoice turned out to already be settled
            // through another channel in the exact same window
            // (outcome: already_paid). Either way the card was genuinely
            // charged, so: hold the claim (releasing it would leave the
            // client's own "Pay Invoice" button, or tomorrow's cron run,
            // free to attempt a charge that already succeeded), and raise
            // an accurate internal-only alert — never the client-facing
            // "please pay manually" message this branch's old code path
            // would have sent.
            await holdPaymentClaim(payment.id, AUTOPAY_HOLD_TTL_MS)
            const detail = `Stripe charged ${paymentIntent.id} successfully but recording it failed or conflicted (confirmPayment outcome: ${confirmResult.outcome}${confirmResult.error ? `: ${confirmResult.error}` : ""}).`
            await raiseAutopayChargeFailure(payment, detail, { chargeSucceeded: true })
            results.push({
              payment_id: payment.id,
              invoice_number: payment.invoice_number,
              outcome: `charged-but-unrecorded — ${paymentIntent.id} (${confirmResult.outcome})`,
            })
          }
        } else {
          await releasePaymentClaim(payment.id)
          await raiseAutopayChargeFailure(payment, `PaymentIntent status: ${paymentIntent.status}`)
          results.push({
            payment_id: payment.id,
            invoice_number: payment.invoice_number,
            outcome: `failed: status ${paymentIntent.status}`,
          })
        }
      } catch (chargeErr) {
        const message = chargeErr instanceof Error ? chargeErr.message : String(chargeErr)
        if (chargeSucceeded) {
          // Stripe already took the money before this exception fired —
          // same "already charged" treatment as the confirmPayment-failure
          // branch above: hold the claim, never tell the client to pay
          // again (dev job 4ca2c691, full council review 2026-09-09).
          await holdPaymentClaim(payment.id, AUTOPAY_HOLD_TTL_MS)
          const detail = `Stripe charged ${chargedPaymentIntentId ?? "(id unknown)"} successfully but a later step failed: ${message}`
          await raiseAutopayChargeFailure(payment, detail, { chargeSucceeded: true })
          results.push({
            payment_id: payment.id,
            invoice_number: payment.invoice_number,
            outcome: `charged-but-unrecorded — error after charge: ${message}`,
          })
        } else {
          await releasePaymentClaim(payment.id)
          await raiseAutopayChargeFailure(payment, message)
          results.push({ payment_id: payment.id, invoice_number: payment.invoice_number, outcome: `error: ${message}` })
        }
      }
    }

    // "charged-but-unrecorded" is its own bucket, distinct from a clean
    // charge (dev job 4ca2c691, full council review 2026-09-09) — Stripe
    // genuinely took the money in both, but this one needs a human, and
    // folding it into a plain "charged" count would understate exactly the
    // thing this fix exists to stop hiding.
    const unrecorded = results.filter((r) => r.outcome.startsWith("charged-but-unrecorded"))
    const charged = results.filter((r) => r.outcome.startsWith("charged") && !r.outcome.startsWith("charged-but-unrecorded"))
    const failed = results.filter((r) => r.outcome.startsWith("failed") || r.outcome.startsWith("error"))

    if (results.length > 0) {
      await supabaseAdmin.from("action_log").insert({
        action_type: "card_autopay_charge_cron",
        table_name: "payments",
        summary: `Card autopay: ${charged.length} charged, ${unrecorded.length} charged-but-unrecorded (needs manual review), ${failed.length} failed, ${results.length} candidates checked`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        details: { today, results } as any,
      })
    }

    logCron({
      endpoint: "/api/cron/card-autopay-charge",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: results.length, charged: charged.length, unrecorded: unrecorded.length, failed: failed.length, results },
    })

    return NextResponse.json({ ok: true, checked: results.length, charged: charged.length, unrecorded: unrecorded.length, failed: failed.length, results })
  } catch (err) {
    logCron({
      endpoint: "/api/cron/card-autopay-charge",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
