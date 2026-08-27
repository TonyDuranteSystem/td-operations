/**
 * CRON: Payment-plan part auto-raise + auto-send.
 *
 * Runs daily. Finds signed/completed offers carrying a payment plan, and for every part whose
 * date trigger has arrived with no live invoice yet occupying its slot, creates the invoice AND
 * emails it to the client — the same outcome as a staffer clicking "Raise invoice" then sending
 * it, minus the click.
 *
 * WHY THIS EXISTS, AND WHY IT STOPS HERE (Antonio, 2026-08-27 council review): the plan's own
 * design (lib/offers/payment-plan.ts) makes a date trigger "something a human is REMINDED of —
 * nothing fires on a schedule, and minting stays a click," on purpose, to keep the standing rule
 * that nothing bills a client unattended. A 7-reviewer council pass on going further — saving a
 * card at signing and auto-CHARGING a later part with no invoice, no click, no client action at
 * all — found that rule was deliberate (reaffirmed three times), the problem it would solve is
 * still hypothetical (one plan-bearing offer has ever existed in production), and the mechanics
 * carry real new risk (off-session EU-card declines with no fallback, a saved-card attack surface
 * that does not exist anywhere in this codebase today, and races with a manual raise happening at
 * the same time). This cron delivers Antonio's actual goal — nothing forgotten — WITHOUT any of
 * that: it never charges anything. It only ever produces an ordinary invoice, through the exact
 * same code the manual "Raise invoice" button already uses, and the client still pays it
 * themselves via the existing Checkout/portal Pay button, exactly like every other invoice today.
 *
 * WHY A SWEEP, NOT A HOOK ON THE PLAN WRITER: same reasoning as plan-referrer-notify's own header
 * — reading plan STATE (via the shared isRaisable/duePartsToAutoRaise predicate) rather than
 * watching a write path is immune to missing a plan that changed by some path this cron's author
 * didn't anticipate.
 *
 * Reliability, deliberately: each part is processed inside its own try/catch so one bad row
 * cannot silently take down the rest of the sweep; the whole run is reported to cron_log on both
 * success and failure, same as every other cron in this codebase.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { getOfficeDateString } from "@/lib/portal/office-hours"
import {
  planStatusForOffer,
  duePartsToAutoRaise,
  resolveTrancheCardFeeRate,
} from "@/lib/offers/payment-plan-state"
import { trancheInvoiceDescription } from "@/lib/offers/payment-plan"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { sendTDInvoice } from "@/lib/invoice-auto-send"
import type { Json } from "@/lib/database.types"

interface CandidateOffer {
  token: string
  client_name: string | null
  account_id: string | null
  contact_id: string | null
  currency: string | null
  services: unknown
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const today = getOfficeDateString()

  try {
    // Candidates: a signed/completed offer carrying a plan. Same status filter as
    // plan-referrer-notify — the offer must genuinely be live, not just structurally present
    // (revise-offer already refuses to touch a signed/completed offer, so this status filter
    // alone rules out a plan whose offer has since been superseded).
    // eslint-disable-next-line no-restricted-syntax -- payment_plan postdates the generated types for this table.
    const offerQuery = supabaseAdmin
      .from("offers")
      .select("token, client_name, account_id, contact_id, currency, services, payment_plan" as never)
      .in("status", ["signed", "completed"])
      .not("payment_plan" as never, "is", null) as unknown as {
        then: PromiseLike<{ data: (CandidateOffer & { payment_plan: unknown })[] | null; error: { message: string } | null }>["then"]
      }
    const { data: offers, error: offersErr } = await offerQuery
    if (offersErr) throw new Error(offersErr.message)

    const results: Array<{ token: string; seq?: number; outcome: string }> = []

    for (const offer of offers ?? []) {
      try {
        const status = await planStatusForOffer(offer.token)
        if (!status) {
          // Stored plan no longer validates — the money rails already refuse; not this cron's
          // job to invent an opinion about a plan staff (or a past revision) already broke.
          continue
        }

        const due = duePartsToAutoRaise(status, today)
        if (due.length === 0) continue

        if (!offer.account_id) {
          for (const d of due) results.push({ token: offer.token, seq: d.part.seq, outcome: "error: offer has no account_id — cannot invoice" })
          continue
        }

        const serviceLabel =
          (Array.isArray(offer.services) && (offer.services[0] as { name?: string } | undefined)?.name) ||
          "Setup Fee"

        for (const partStatus of due) {
          const part = partStatus.part
          try {
            const description = trancheInvoiceDescription(part, status.plan.length, serviceLabel)
            const cardFeeRate = await resolveTrancheCardFeeRate(offer.token)

            const invoice = await createTDInvoice({
              account_id: offer.account_id,
              contact_id: offer.contact_id ?? undefined,
              line_items: [{ description, unit_price: part.amount, quantity: 1 }],
              currency: part.currency === "EUR" ? "EUR" : "USD",
              due_date: part.trigger.date,
              // Same natural key the manual "Raise invoice" action uses — a concurrent manual
              // raise for the same part and this cron's own retry both collapse onto one invoice.
              idempotency_key: `offer-tranche:${offer.token}:${part.seq}`,
              tranche_offer_token: offer.token,
              tranche_seq: part.seq,
              payment_category: "setup_tranche",
              ...(cardFeeRate !== undefined ? { card_fee_rate: cardFeeRate } : {}),
            })

            // Only send a genuinely NEW Draft — createTDInvoice's idempotency key can return an
            // ALREADY-Sent or Paid row (a manual raise won the race, or this is a retry after a
            // previous run's send failed partway); sendTDInvoice itself also refuses anything
            // that isn't Draft, but checking here keeps the result log honest about what happened.
            if (invoice.status === "Draft") {
              await sendTDInvoice(invoice.paymentId)
              results.push({ token: offer.token, seq: part.seq, outcome: `sent — ${invoice.invoiceNumber}` })
            } else {
              results.push({ token: offer.token, seq: part.seq, outcome: `already ${invoice.status.toLowerCase()} — ${invoice.invoiceNumber}` })
            }
          } catch (partErr) {
            results.push({
              token: offer.token,
              seq: part.seq,
              outcome: `error: ${partErr instanceof Error ? partErr.message : String(partErr)}`,
            })
          }
        }
      } catch (offerErr) {
        // Fault isolation: one bad offer must not abort the sweep for the rest.
        results.push({ token: offer.token, outcome: `error: ${offerErr instanceof Error ? offerErr.message : String(offerErr)}` })
      }
    }

    const sent = results.filter((r) => r.outcome.startsWith("sent"))
    const errored = results.filter((r) => r.outcome.startsWith("error"))

    if (results.length > 0) {
      await supabaseAdmin.from("action_log").insert({
        action_type: "plan_part_auto_raise_cron",
        table_name: "payments",
        summary: `Payment-plan auto-raise: ${sent.length} sent, ${errored.length} errors, ${results.length} candidates checked`,
        details: { today, results } as unknown as Json,
      })
    }

    logCron({
      endpoint: "/api/cron/plan-part-auto-raise",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: results.length, sent: sent.length, errored: errored.length, results },
    })

    return NextResponse.json({ ok: true, checked: results.length, sent: sent.length, errored: errored.length, results })
  } catch (err) {
    logCron({
      endpoint: "/api/cron/plan-part-auto-raise",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
