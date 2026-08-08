/**
 * POST /api/feed/create-from-feed
 *
 * Bank-feed-tab variant of the Step 14 create-service-from-feed flow.
 *
 * Two branches keyed on the request body:
 *
 *   Branch A — ATTACH to an existing active service delivery on the target.
 *     Body: { feed_id, account_id|contact_id, service_delivery_id }
 *     Behavior: createTDInvoice + manualMatch. NO new SD created. Used when
 *     the target client already has an active SD that this payment relates to
 *     (e.g. a Tax Return SD mid-pipeline).
 *
 *   Branch B — CREATE a new backfilled service delivery + invoice.
 *     Body: { feed_id, account_id|contact_id, service_type, service_name? }
 *     Behavior: createBackfilledSD + createTDInvoice + manualMatch. Used for
 *     genuine one-off services (Public Notary, Shipping, Support) where no
 *     pipeline SD exists.
 *
 * Target selection is account-OR-contact (XOR). Both branches work for both
 * target types — contact targets are first-class per the formation
 * architecture model "ownership = whoever paid, never migrates".
 *
 * Idempotency: payments.idempotency_key = `feed-flow-create:<feed_id>`.
 *
 * Auth: dashboard session (admin staff use the bank-feed UI).
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { manualMatch } from "@/lib/bank-feed-matcher"
import { recordPaidCall } from "@/lib/operations/paid-call-credit"
import { parsePaidCallRequest } from "@/lib/calendly/paid-booking"
import {
  createBackfilledSD,
  isValidServiceType,
} from "@/lib/operations/service-delivery"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

interface Body {
  feed_id?: string
  account_id?: string
  contact_id?: string
  /** Branch B only — required when service_delivery_id is absent. */
  service_type?: string
  /** Branch B only — defaults to service_type. */
  service_name?: string
  /** Branch A — when set, attach payment to this SD instead of creating one. */
  service_delivery_id?: string
  /** Branch C — this transaction was a PAID STRATEGY CALL. Contact target only. */
  paid_call?: boolean
  /** Branch C — "revenue only, history kept": the credit is born already used. */
  paid_call_revenue_only?: boolean
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const feedId = body.feed_id?.trim()
  const accountId = body.account_id?.trim()
  const contactId = body.contact_id?.trim()
  const serviceDeliveryId = body.service_delivery_id?.trim()
  const serviceType = body.service_type?.trim()
  const serviceName = (body.service_name?.trim() || serviceType || "").slice(0, 200)
  // Strict: a malformed flag is an ERROR, never a silent "not a paid call"
  // that then fails complaining about something unrelated.
  const paidCallReq = parsePaidCallRequest(body as unknown as Record<string, unknown>)
  if (paidCallReq.kind === "invalid") {
    return NextResponse.json({ error: paidCallReq.reason }, { status: 400 })
  }
  const isPaidCall = paidCallReq.kind === "paid_call"
  const paidCallRevenueOnly = paidCallReq.kind === "paid_call" && paidCallReq.revenueOnly

  // ── Validation ──────────────────────────────────────────────────────
  if (!feedId) {
    return NextResponse.json({ error: "feed_id is required" }, { status: 400 })
  }
  if (!accountId && !contactId) {
    return NextResponse.json(
      { error: "account_id or contact_id required" },
      { status: 400 },
    )
  }
  if (accountId && contactId) {
    return NextResponse.json(
      { error: "pass account_id OR contact_id, not both" },
      { status: 400 },
    )
  }


  // ── BRANCH C — PAID STRATEGY CALL (Antonio's ruling) ─────────────────
  //
  // A client paid for a call under an address the system cannot tie to them, so
  // no automatic recognition happened and the transaction sits unmatched. Staff
  // name the person; we record exactly what the automatic path records.
  //
  // A paid call is NOT a service delivery, so this branch deliberately creates
  // none — that is why it is its own branch rather than another service type.
  //
  // TWO OUTCOMES, both keeping the history:
  //   deductible (default) — a usable person-scoped credit
  //   revenue only         — the credit is born with nothing left on it, so
  //                          nothing is deductible but the client's history
  //                          still shows they paid for a call.
  if (isPaidCall) {
    if (!contactId) {
      return NextResponse.json(
        { error: "A paid strategy call is recorded against a PERSON — pick a contact, not a company." },
        { status: 400 },
      )
    }

    const { data: feedRow } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("amount, currency, transaction_date, status")
      .eq("id", feedId)
      .maybeSingle()
    const feed = feedRow as { amount: number; currency: string; transaction_date: string; status: string } | null
    if (!feed) return NextResponse.json({ error: "Transaction not found" }, { status: 404 })

    const { data: person } = await supabaseAdmin
      .from("contacts").select("email, full_name").eq("id", contactId).maybeSingle()
    const p = person as { email: string | null; full_name: string | null } | null
    if (!p?.email) {
      return NextResponse.json(
        { error: "That contact has no email address, so the credit could never be found again. Add one first." },
        { status: 400 },
      )
    }

    try {
      const result = await recordPaidCall({
        payment: {
          chargeId: `feed:${feedId}`,
          amount: Number(feed.amount),
          currency: String(feed.currency).toUpperCase() === "EUR" ? "EUR" : "USD",
          provider: "manual",
        },
        inviteeEmail: p.email,
        inviteeName: p.full_name,
        callDate: feed.transaction_date,
        manual: { feedId, creditUsedAtCreation: paidCallRevenueOnly },
      })

      const match = await manualMatch(feedId, result.invoiceId)
      return NextResponse.json({
        paid_call: true,
        revenue_only: paidCallRevenueOnly,
        payment_id: result.invoiceId,
        invoice_number: result.invoiceNumber,
        credit_id: result.creditId,
        credit_number: result.creditNumber,
        contact_id: result.contactId,
        sd_id: null,
        ...(match.matched ? {} : { warning: `Recorded, but the feed link failed: ${match.error}` }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: `Could not record the paid call: ${msg}` }, { status: 500 })
    }
  }

  const isAttachBranch = !!serviceDeliveryId
  if (!isAttachBranch) {
    // Branch B requires service_type; service_type must be canonical.
    if (!serviceType) {
      return NextResponse.json(
        {
          error:
            "service_type is required (or pass service_delivery_id to attach to an existing service)",
        },
        { status: 400 },
      )
    }
    if (!isValidServiceType(serviceType)) {
      return NextResponse.json(
        {
          error: `Invalid service_type "${serviceType}". Pick one from the dropdown.`,
        },
        { status: 400 },
      )
    }
  }

  // ── Fetch feed ──────────────────────────────────────────────────────
  const { data: feed, error: feedErr } = await supabaseAdmin
    .from("td_bank_feeds")
    .select(
      "id, source, transaction_date, amount, currency, sender_name, status, matched_payment_id",
    )
    .eq("id", feedId)
    .single()
  if (feedErr || !feed) {
    return NextResponse.json(
      { error: `Bank feed not found: ${feedErr?.message ?? "no row"}` },
      { status: 404 },
    )
  }
  if (feed.status === "matched" && feed.matched_payment_id) {
    return NextResponse.json(
      { error: "Bank feed already matched to a payment" },
      { status: 409 },
    )
  }

  // ── Validate the SD belongs to the chosen target (Branch A) ────────
  if (isAttachBranch) {
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, account_id, contact_id, status")
      .eq("id", serviceDeliveryId!)
      .maybeSingle()
    if (sdErr || !sd) {
      return NextResponse.json(
        { error: `Service delivery not found: ${sdErr?.message ?? "no row"}` },
        { status: 404 },
      )
    }
    const sdMatchesTarget =
      (accountId && sd.account_id === accountId) ||
      (contactId && sd.contact_id === contactId && sd.account_id === null)
    if (!sdMatchesTarget) {
      return NextResponse.json(
        { error: "Service delivery does not belong to the chosen target" },
        { status: 400 },
      )
    }
    if (sd.status !== "active") {
      return NextResponse.json(
        { error: `Service delivery is ${sd.status}, only active SDs can be attached` },
        { status: 400 },
      )
    }
  }

  const idempotencyKey = `feed-flow-create:${feedId}`

  // ── Idempotency guard ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingPayment } = await (supabaseAdmin as any)
    .from("payments")
    .select("id")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()
  if (existingPayment?.id) {
    return NextResponse.json({
      payment_id: existingPayment.id,
      idempotent: true,
    })
  }

  const currency = (feed.currency || "USD").toUpperCase()
  const txnDate: string =
    typeof feed.transaction_date === "string"
      ? feed.transaction_date.slice(0, 10)
      : new Date(feed.transaction_date as unknown as string | number | Date)
          .toISOString()
          .slice(0, 10)

  // ── Branch B: create the backfilled SD first ───────────────────────
  let sdId: string | null = null
  if (!isAttachBranch) {
    try {
      const sd = await createBackfilledSD({
        account_id: accountId,
        contact_id: contactId,
        service_type: serviceType!,
        service_name: serviceName,
        amount: Number(feed.amount),
        amount_currency: currency,
        delivered_on: txnDate,
        notes: `Created from bank feed (feed-flow-source:${feedId})`,
      })
      sdId = sd.id
    } catch (err) {
      return NextResponse.json(
        {
          error: `Failed to create service delivery: ${err instanceof Error ? err.message : "unknown"}`,
        },
        { status: 500 },
      )
    }
  } else {
    sdId = serviceDeliveryId!
  }

  // ── createTDInvoice — paid, idempotent ─────────────────────────────
  const description =
    serviceName ||
    (contactId ? `Wire payment from ${feed.sender_name ?? "individual"}` : "Service")
  let invoice
  try {
    invoice = await createTDInvoice({
      account_id: accountId,
      contact_id: contactId,
      line_items: [
        { description, unit_price: Number(feed.amount), quantity: 1 },
      ],
      currency: currency === "EUR" ? "EUR" : "USD",
      mark_as_paid: true,
      paid_date: txnDate,
      payment_method: feed.source,
      idempotency_key: idempotencyKey,
      installment: "One-Time Service",
      notes: `Bank-feed flow — created from bank feed ${feedId}`,
    })
  } catch (err) {
    // Roll back the SD only if WE just created it (Branch B). Branch A's
    // SD pre-existed and is not ours to delete.
    if (!isAttachBranch && sdId) {
      await supabaseAdmin.from("service_deliveries").delete().eq("id", sdId)
    }
    return NextResponse.json(
      {
        error: `Failed to create invoice: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 },
    )
  }

  // ── manualMatch ────────────────────────────────────────────────────
  const matchResult = await manualMatch(feedId, invoice.paymentId)
  if (!matchResult.matched) {
    return NextResponse.json({
      sd_id: sdId,
      payment_id: invoice.paymentId,
      invoice_number: invoice.invoiceNumber,
      attached: isAttachBranch,
      warning: `Invoice created, but feed link failed: ${matchResult.error}`,
    })
  }

  return NextResponse.json({
    sd_id: sdId,
    payment_id: invoice.paymentId,
    invoice_number: invoice.invoiceNumber,
    attached: isAttachBranch,
  })
}
