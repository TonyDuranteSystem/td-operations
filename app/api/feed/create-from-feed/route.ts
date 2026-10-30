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
import { findOrCreatePayerContact, removeJustCreatedPayerContact, payerContactIdForFeed } from "@/lib/operations/feed-payer-contact"
import { writeFeedStoryToInvoices, describeStoryResult } from "@/lib/operations/feed-story-note"
import { stripeRefundGate } from "@/lib/finance/refund-gate"

export const dynamic = "force-dynamic"

interface Body {
  feed_id?: string
  account_id?: string
  contact_id?: string
  /**
   * Branch C only — a LEAD who has paid for something (a strategy call) but
   * has not signed/paid for a real service yet, so no contact record exists
   * for them. Deliberately not accepted by Branch A/B: a lead has no service
   * deliveries to attach to and no business creating one — only the paid-call
   * path is valid for this target type.
   */
  lead_id?: string
  /** Branch B only — required when service_delivery_id is absent. */
  service_type?: string
  /** Branch B only — defaults to service_type. */
  service_name?: string
  /** Branch A — when set, attach payment to this SD instead of creating one. */
  service_delivery_id?: string
  /** Branch C — this transaction was a PAID STRATEGY CALL. Contact or lead target only. */
  paid_call?: boolean
  /** Branch C — "revenue only, history kept": the credit is born already used. */
  paid_call_revenue_only?: boolean
  /**
   * Branch B only — the payer is NOT in the CRM at all (not a client, not a lead): create a plain person
   * from this and invoice them. Mutually exclusive with account/contact/lead; never with a paid call.
   */
  new_contact?: { full_name?: unknown; email?: unknown }
  /**
   * Write the payment's AI investigation, if it has one worth writing, on the invoice note. Default on;
   * `false` when staff unticked it.
   */
  save_story?: boolean
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
  const leadId = body.lead_id?.trim()
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
  const newContact = body.new_contact && typeof body.new_contact === "object" ? body.new_contact : null
  const targetCount = [accountId, contactId, leadId, newContact].filter(Boolean).length
  if (targetCount === 0) {
    return NextResponse.json(
      { error: "account_id, contact_id, lead_id or new_contact required" },
      { status: 400 },
    )
  }
  if (targetCount > 1) {
    return NextResponse.json(
      { error: "pass exactly one of account_id, contact_id, lead_id or new_contact" },
      { status: 400 },
    )
  }
  if (newContact && (isPaidCall || serviceDeliveryId)) {
    return NextResponse.json(
      { error: "A new person gets a service invoice: a paid strategy call and attaching to an existing service need a person who is already in the CRM." },
      { status: 400 },
    )
  }
  // A lead has no service deliveries and no business getting a real invoice
  // for one — the ONLY thing a lead target may be used for is recording a
  // paid call. Antonio's rule: recording it must never itself convert the
  // lead into a client.
  if (leadId && !isPaidCall) {
    return NextResponse.json(
      { error: "A lead can only be used for a paid strategy call — pick or create a contact for any other invoice." },
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
    if (!contactId && !leadId) {
      return NextResponse.json(
        { error: "A paid strategy call is recorded against a PERSON — pick a contact or a lead, not a company." },
        { status: 400 },
      )
    }

    const { data: feedRow } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("amount, currency, transaction_date, status, source, external_id")
      .eq("id", feedId)
      .maybeSingle()
    const feed = feedRow as { amount: number; currency: string; transaction_date: string; status: string; source: string | null; external_id: string | null } | null
    if (!feed) return NextResponse.json({ error: "Transaction not found" }, { status: 404 })

    // A refunded or disputed card payment is not our money any more. Asked BEFORE anything is recorded: the
    // link to the feed refuses a refunded charge too, but only after the invoice and credit already exist.
    const paidCallRefundGate = await stripeRefundGate(feed)
    if (paidCallRefundGate.error) return NextResponse.json({ error: paidCallRefundGate.error }, { status: 409 })

    // Resolve the target's email/name/is_test regardless of whether it's an
    // existing contact or a lead who hasn't become one yet — recordPaidCall
    // only ever needs an email; it finds-or-creates the actual contact.
    let personEmail: string | null = null
    let personName: string | null = null
    let personIsTest = false
    if (contactId) {
      const { data: person } = await supabaseAdmin
        .from("contacts").select("email, full_name, is_test").eq("id", contactId).maybeSingle()
      const p = person as { email: string | null; full_name: string | null; is_test: boolean | null } | null
      personEmail = p?.email ?? null
      personName = p?.full_name ?? null
      personIsTest = !!p?.is_test
    } else if (leadId) {
      const { data: lead } = await supabaseAdmin
        .from("leads").select("email, full_name, is_test").eq("id", leadId).maybeSingle()
      const l = lead as { email: string | null; full_name: string | null; is_test: boolean | null } | null
      if (!l) return NextResponse.json({ error: "Lead not found" }, { status: 404 })
      personEmail = l.email
      personName = l.full_name
      personIsTest = !!l.is_test
    }
    if (!personEmail) {
      return NextResponse.json(
        { error: `That ${leadId ? "lead" : "contact"} has no email address, so the credit could never be found again. Add one first.` },
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
        inviteeEmail: personEmail,
        inviteeName: personName,
        callDate: feed.transaction_date,
        isTest: personIsTest,
        manual: { feedId, creditUsedAtCreation: paidCallRevenueOnly },
      })

      // Idempotent replay guard: the invoice/credit pair is keyed on the FEED
      // row, not the target, so re-submitting this same transaction against a
      // DIFFERENT person (a wrong pick, corrected and resubmitted; or two
      // duplicate lead rows for the same human) would otherwise return the
      // FIRST attempt's invoice while this response reports the freshly
      // resolved contact — money silently stays on the wrong person while
      // staff are told it succeeded on the right one. Verify they agree.
      const { data: bookedRow } = await supabaseAdmin
        .from("payments").select("contact_id").eq("id", result.invoiceId).maybeSingle()
      const bookedContactId = (bookedRow as { contact_id: string | null } | null)?.contact_id ?? null
      if (bookedContactId && bookedContactId !== result.contactId) {
        return NextResponse.json(
          {
            error:
              "This transaction was already recorded as a paid call for a different person. " +
              "If that was the wrong pick, fix it by hand on the existing invoice/credit — resubmitting here will not move the money.",
          },
          { status: 409 },
        )
      }

      // Tag the LEAD (never converted_to_contact_id — that flips status to
      // Converted and is reserved for a real signed+paid offer, R094). Mirrors
      // the Calendly webhook's own existing pattern for the same situation:
      // the CRM's lead/contact-link diagnostic already knows this column
      // means "linked, but deliberately not a sales conversion" and won't
      // flag it — the lead stays exactly a lead. Only set if not already
      // pointing somewhere, so this never clobbers an existing link.
      if (leadId) {
        const { error: tagErr } = await supabaseAdmin
          .from("leads")
          .update({ existing_client_contact_id: result.contactId })
          .eq("id", leadId)
          .is("existing_client_contact_id", null)
        if (tagErr) console.error(`[create-from-feed] failed to tag lead ${leadId} with contact ${result.contactId}:`, tagErr.message)
      }

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
      "id, source, external_id, transaction_date, amount, currency, sender_name, status, matched_payment_id, owner_account_number",
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
  // TD's own private money, and a transaction already marked a duplicate, are not for client invoices.
  if (feed.status === "outgoing" || feed.status === "owner_ledger" || feed.status === "duplicate" || feed.owner_account_number) {
    return NextResponse.json({ error: "This transaction cannot be invoiced from here." }, { status: 400 })
  }
  // An invoice can only be USD or EUR (createTDInvoice). Any other currency used to be quietly relabelled
  // USD — an invoice for the wrong money. A payment that is not positive would become a credit note.
  const feedCurrency = String(feed.currency ?? "").toUpperCase()
  if (feedCurrency !== "USD" && feedCurrency !== "EUR") {
    return NextResponse.json(
      { error: `This payment is in ${feedCurrency || "an unknown currency"}. Invoices can only be in USD or EUR, so it cannot be invoiced from here.` },
      { status: 400 },
    )
  }
  if (!(Number(feed.amount) > 0)) {
    return NextResponse.json({ error: "Only a payment received (a positive amount) can be invoiced." }, { status: 400 })
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
    .select("id, account_id, contact_id, invoice_number")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()
  if (existingPayment?.id) {
    // The invoice is keyed on the PAYMENT, not on who it was for. A retry that names a DIFFERENT person or
    // company would otherwise link the payment to the first attempt's invoice and report success for the
    // new pick: money stays on the wrong party under a green message. Refuse and say where it went.
    const wantedContactId = newContact ? payerContactIdForFeed(feedId) : contactId
    const sameTarget = accountId
      ? existingPayment.account_id === accountId
      : !!wantedContactId && existingPayment.contact_id === wantedContactId
    if (!sameTarget) {
      return NextResponse.json(
        {
          error:
            `This payment already has an invoice${existingPayment.invoice_number ? ` (${existingPayment.invoice_number})` : ""} made for someone else. ` +
            "Picking a different person or company here will not move it. If that was the wrong pick, correct it on that invoice.",
        },
        { status: 409 },
      )
    }
    // The invoice already exists for this payment. If the earlier attempt made it but the link to the feed
    // failed, a retry must finish that link — not report success over a payment that is still unmatched.
    const invoiceNumber: string | null = existingPayment.invoice_number ?? null
    let warning: string | undefined
    let linked = feed.status === "matched" && feed.matched_payment_id === existingPayment.id
    if (!linked) {
      const retry = await manualMatch(feedId, existingPayment.id)
      if (retry.matched) linked = true
      else warning = `Invoice already created, but the feed link failed: ${retry.error}`
    }
    // The first attempt stopped before the story step, so the retry that finishes the link writes it.
    const retryStory = linked && body.save_story !== false
      ? describeStoryResult(await writeFeedStoryToInvoices(feedId, [existingPayment.id], [existingPayment.id]))
      : null
    return NextResponse.json({
      payment_id: existingPayment.id,
      invoice_number: invoiceNumber,
      idempotent: true,
      ...(warning ? { warning } : {}),
      ...(retryStory ? { story: retryStory } : {}),
    })
  }

  // A refunded or disputed card payment is not our money any more, and the link to the feed refuses it — but
  // only AFTER the person, the service delivery and a PAID invoice exist. Ask Stripe before creating anything.
  // (After the idempotency guard: an invoice that already exists is finished by the retry above.)
  const refundGate = await stripeRefundGate(feed)
  if (refundGate.error) return NextResponse.json({ error: refundGate.error }, { status: 409 })

  // ── New person (the payer is not in the CRM) ───────────────────────
  // After the idempotency guard, so a repeat never makes a second person; before the service delivery,
  // so a refusal ("already in the CRM") leaves nothing behind.
  let effectiveContactId: string | undefined = contactId
  let createdContactId: string | null = null
  if (newContact) {
    const made = await findOrCreatePayerContact(newContact, feedId)
    if (made.ok === false) {
      const status = made.kind === "exists" || made.kind === "in_progress" ? 409 : made.kind === "invalid" ? 400 : 500
      return NextResponse.json({ error: made.error, ...(made.kind === "exists" ? { existing: made.existing } : {}) }, { status })
    }
    effectiveContactId = made.contactId
    if (made.created) createdContactId = made.contactId
  }
  const undoNewContact = async () => {
    if (createdContactId) await removeJustCreatedPayerContact(createdContactId)
  }

  const currency = feedCurrency
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
        contact_id: effectiveContactId,
        service_type: serviceType!,
        service_name: serviceName,
        amount: Number(feed.amount),
        amount_currency: currency,
        delivered_on: txnDate,
        notes: `Created from bank feed (feed-flow-source:${feedId})`,
      })
      sdId = sd.id
    } catch (err) {
      await undoNewContact()
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
    (effectiveContactId ? `Wire payment from ${feed.sender_name ?? "individual"}` : "Service")
  let invoice
  try {
    invoice = await createTDInvoice({
      account_id: accountId,
      contact_id: effectiveContactId,
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
    let sdRolledBack = true
    if (!isAttachBranch && sdId) {
      const { error: rollbackErr } = await supabaseAdmin.from("service_deliveries").delete().eq("id", sdId)
      if (rollbackErr) {
        sdRolledBack = false
        console.error(`[create-from-feed] could not roll back service delivery ${sdId} after an invoice failure:`, rollbackErr.message)
      }
    }
    // The new person goes too — but only if the service delivery that pointed at them is gone (otherwise the
    // database would refuse, and a person somebody references must stay).
    if (sdRolledBack) await undoNewContact()
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
      contact_id: effectiveContactId ?? null,
      attached: isAttachBranch,
      warning: `Invoice created, but feed link failed: ${matchResult.error}`,
    })
  }

  // The payment's AI investigation, if it has one worth writing, goes on this invoice's internal note.
  // Best effort: never fails the invoice.
  const story = body.save_story === false ? null : describeStoryResult(await writeFeedStoryToInvoices(feedId, [invoice.paymentId], [invoice.paymentId]))

  return NextResponse.json({
    sd_id: sdId,
    payment_id: invoice.paymentId,
    invoice_number: invoice.invoiceNumber,
    contact_id: effectiveContactId ?? null,
    attached: isAttachBranch,
    ...(story ? { story } : {}),
  })
}
