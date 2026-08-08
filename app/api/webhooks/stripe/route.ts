/**
 * Stripe Webhook Endpoint
 *
 * Receives payment events from Stripe.
 * Mirrors the Whop webhook handler logic:
 *   - checkout.session.completed → lookup client by email/metadata, create CRM payment,
 *     match pending_activation, trigger activate-service
 *   - payment_intent.payment_failed → log failure, create task
 *
 * Advantage over Whop: metadata carries offer_token for exact matching.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { runActivation } from "@/lib/operations/activate-service"
import { resolveExternalValue } from "@/lib/catalog/framework"
import { handleChargeReversal } from "@/lib/operations/credit-reversal"

// Lightweight types for Stripe objects (v22 has different namespace pattern)
interface StripeEvent {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

interface StripeSession {
  id: string
  payment_intent: string | null
  amount_total: number | null
  currency: string | null
  customer_details: { email: string | null; name: string | null } | null
  metadata: Record<string, string> | null
}

let _supabase: SupabaseClient | null = null
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _supabase
}

// ─── Signature Verification ──────────────────────────────────────

async function verifyStripeSignature(body: string, signature: string): Promise<StripeEvent | null> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!secret) {
    // Fail CLOSED: with no secret we cannot verify the signature, so we must
    // reject rather than trust an unsigned payload. Accepting it would let
    // anyone forge a checkout.session.completed and trigger a fraudulent
    // activation (security audit 2026-06-13, C2). The Slack webhooks fail
    // closed the same way.
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — rejecting webhook (fail closed)")
    return null
  }

  // Parse Stripe signature header: t=timestamp,v1=signature
  const parts = signature.split(",")
  const tsEntry = parts.find(p => p.startsWith("t="))
  const sigEntry = parts.find(p => p.startsWith("v1="))

  if (!tsEntry || !sigEntry) {
    console.error("[stripe-webhook] Malformed signature header:", signature.slice(0, 50))
    return null
  }

  const timestamp = tsEntry.slice(2)
  const expectedSig = sigEntry.slice(3)

  // Reject old timestamps (5 min tolerance)
  const ts = parseInt(timestamp, 10)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > 300) {
    console.error("[stripe-webhook] Timestamp too old:", ts, "now:", now)
    return null
  }

  // Compute HMAC-SHA256 of "timestamp.body" using the webhook secret
  const signedPayload = `${timestamp}.${body}`
  const encoder = new TextEncoder()

  // Stripe uses the full secret string as HMAC key (including whsec_ prefix if present)
  const keyBytes = encoder.encode(secret).buffer as ArrayBuffer

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload))
  const computedHex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")

  if (computedHex !== expectedSig) {
    console.error("[stripe-webhook] Signature mismatch")
    console.error("[stripe-webhook] Expected:", expectedSig.slice(0, 20) + "...")
    console.error("[stripe-webhook] Computed:", computedHex.slice(0, 20) + "...")
    return null
  }

  return JSON.parse(body) as StripeEvent
}

// ─── Event Handlers ──────────────────────────────────────────────

async function handleCheckoutCompleted(session: StripeSession) {
  const sessionId = session.id
  const paymentIntentId = session.payment_intent as string | null
  const email = session.customer_details?.email || session.metadata?.client_email || null
  const total = (session.amount_total || 0) / 100 // Stripe uses cents → major units
  const currency = (session.currency || "usd").toUpperCase()
  const clientName = session.metadata?.client_name || session.customer_details?.name || null
  const offerToken = session.metadata?.offer_token || null
  const leadIdFromMeta = session.metadata?.lead_id || null
  const contractType = session.metadata?.contract_type || null

  console.warn(`[stripe-webhook] checkout.session.completed: ${sessionId} — ${clientName || email} — ${currency} ${total}`)

  // Anti-corruption layer (Phase 1, observational only): record any
  // unrecognized contract_type into catalog_pending_review so we can map
  // them to canonical service slugs in Phase 2. Does not change webhook
  // behavior — failures are swallowed.
  if (contractType) {
    try {
      await resolveExternalValue("services", contractType, "stripe_webhook", {
        session_id: sessionId,
        email,
        client_name: clientName,
        payment_intent_id: paymentIntentId,
        offer_token: offerToken,
      })
    } catch (err) {
      console.warn(
        `[stripe-webhook] catalog resolveExternalValue failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // 1. Log webhook event
  await getSupabase().from("webhook_events").insert({
    source: "stripe",
    event_type: "checkout.session.completed",
    external_id: sessionId,
    payload: session as unknown as Record<string, unknown>,
  })

  // 2. Look up client by email in CRM
  let accountId: string | null = null
  let contactId: string | null = null
  let leadId: string | null = leadIdFromMeta

  if (email) {
    // Check contacts first
    const { data: contacts } = await getSupabase()
      .from("contacts")
      .select("id, account_contacts(account_id)")
      .ilike("email", email)
      .limit(1)

    if (contacts && contacts.length > 0) {
      contactId = contacts[0].id
      const ac = contacts[0].account_contacts as Array<{ account_id: string }> | null
      if (ac && ac.length > 0) {
        accountId = ac[0].account_id
      }
    }

    // Check leads
    if (!leadId) {
      const { data: leads } = await getSupabase()
        .from("leads")
        .select("id")
        .ilike("email", email)
        .limit(1)

      if (leads && leads.length > 0) {
        leadId = leads[0].id
      }
    }
  }

  // 3. Idempotency check — skip if already processed
  if (paymentIntentId) {
    const { data: existingPayment } = await getSupabase()
      .from("payments")
      .select("id")
      .eq("stripe_payment_id", paymentIntentId)
      .limit(1)
    if (existingPayment && existingPayment.length > 0) {
      console.warn(`[stripe-webhook] Payment ${paymentIntentId} already processed — skipping duplicate`)
      return NextResponse.json({ ok: true, message: "Duplicate webhook, already processed" })
    }
  }

  // 3b. Look up pending_activation early so we can gate the raw payments insert.
  // When a draft TD invoice was created at offer-signing (portal_invoice_id set
  // on the activation), the auto-reconcile branch below flips that draft to
  // Paid via syncInvoiceStatus('payment', ...). Inserting a raw row here would
  // create a duplicate Paid row with no invoice_number and no client_expenses
  // mirror. Same gate pattern as confirm-payment Step 8 (PR 1).
  let activationPortalInvoiceId: string | null = null
  if (offerToken || email) {
    let paQuery = getSupabase()
      .from("pending_activations")
      .select("id, portal_invoice_id")
      .eq("status", "awaiting_payment")
      .limit(1)
    paQuery = offerToken
      ? paQuery.eq("offer_token", offerToken)
      : paQuery.eq("client_email", email!)
    const { data: paRows } = await paQuery
    if (paRows?.length) activationPortalInvoiceId = paRows[0].portal_invoice_id
  }

  // 3c. Reconcile to an EXISTING invoice when the portal Pay-link carried its
  //     number (the common case: a 2nd-installment / annual invoice paid by
  //     card). Mark THAT invoice Paid + fire the installment handler via the
  //     shared confirmPayment path — the SAME engine wires use — instead of
  //     inserting an orphan "annual_renewal" row that leaves the real invoice
  //     Overdue. Bug fix: Stripe portal payments were creating duplicate paid
  //     rows. Reconcile by the (globally-unique) invoice number, so it works
  //     even when a third party pays (we match the invoice, not the payer name).
  const metaInvoiceNumber = session.metadata?.invoice_number || null
  let reconciledExistingInvoice = false
  if (!activationPortalInvoiceId && metaInvoiceNumber) {
    // CARD FEE (dev_task 6ec6872a): before settling, book the fee ONTO this invoice
    // from the ACTUAL charge, so the settle credits base+fee (it caps at the invoice
    // total). bookCardFee is all-or-throw → a failure propagates to a non-200 and
    // Stripe retries from a non-terminal invoice. On base-mismatch it returns
    // 'overage' (settle at base, raise a review).
    const { data: feeInv } = await getSupabase()
      .from("payments").select("id").eq("invoice_number", metaInvoiceNumber).maybeSingle()
    if (feeInv?.id) {
      const { bookCardFee } = await import("@/lib/finance/card-fee-booking")
      const feeResult = await bookCardFee(feeInv.id as string, total)
      if (feeResult.outcome === "overage") {
        const { raiseCardFeeOverageIssue } = await import("@/lib/finance/card-fee-issues")
        await raiseCardFeeOverageIssue({ paymentId: feeInv.id as string, base: feeResult.base, charged: total, gatewayPaymentId: paymentIntentId || sessionId })
      }
    }
    const { reconcilePaymentByInvoiceNumber } = await import("@/lib/operations/payment")
    const r = await reconcilePaymentByInvoiceNumber(metaInvoiceNumber, {
      amountPaid: total,
      paidDate: new Date().toISOString().split("T")[0],
      stripePaymentId: paymentIntentId || sessionId,
    })
    if (r.reconciled && r.payment_id) {
      reconciledExistingInvoice = true
      const { emitPaymentReceivedEvent } = await import("@/lib/portal/chat-events")
      await emitPaymentReceivedEvent({ payment_id: r.payment_id, method_hint: "Stripe" })
      console.warn(`[stripe-webhook] Reconciled Stripe payment to existing invoice ${metaInvoiceNumber} (no orphan row)`)
    }
  }

  // 4. Create payment record (skipped when offer-signed created a draft, or
  //    when 3c reconciled to an existing invoice).
  const productName = session.metadata?.contract_type
    ? `${session.metadata.contract_type === "formation" ? "LLC Formation" : session.metadata.contract_type} — ${clientName || email || "unknown"}`
    : `Stripe payment — ${clientName || email || "unknown"}`

  const paymentRecord: Record<string, unknown> = {
    amount: total,
    subtotal: total,
    total: total,
    amount_paid: total,
    amount_currency: currency === "USD" ? "USD" : "EUR",
    paid_date: new Date().toISOString().split("T")[0],
    status: "Paid",
    payment_method: "Stripe",
    description: productName,
    notes: `Stripe session ${sessionId}. PaymentIntent: ${paymentIntentId || "N/A"}.`,
    stripe_payment_id: paymentIntentId || sessionId,
  }
  if (accountId) paymentRecord.account_id = accountId
  if (contactId) paymentRecord.contact_id = contactId

  if (!activationPortalInvoiceId && !reconciledExistingInvoice) {
    // eslint-disable-next-line no-restricted-syntax -- Stripe-webhook payment record insert; tracked by dev_task 7ebb1e0c
    const { data: payRow, error: payErr } = await getSupabase().from("payments").insert(paymentRecord).select("id").single()
    if (payErr) {
      console.error("[stripe-webhook] Failed to create payment:", payErr.message)
    } else if (payRow?.id) {
      // Surface a Billing-topic system message in portal-chats so staff sees a
      // red unread dot the moment Stripe confirms the payment. Non-fatal.
      const { emitPaymentReceivedEvent } = await import("@/lib/portal/chat-events")
      await emitPaymentReceivedEvent({ payment_id: payRow.id as string, method_hint: "Stripe" })
    }
  } else if (activationPortalInvoiceId) {
    console.warn(`[stripe-webhook] Skipping raw payments insert — activation has draft invoice ${activationPortalInvoiceId}; auto-reconcile will flip it Paid`)
  }

  // 6. Update lead status to "Converted"
  if (leadId) {
    await getSupabase()
      .from("leads")
      .update({ status: "Converted", updated_at: new Date().toISOString() })
      .eq("id", leadId)
  }

  // 7. Upgrade portal tier: lead → formation|onboarding (syncs account + contacts)
  let resolvedAccountId = accountId
  if (!resolvedAccountId && email) {
    // Resolve account via contact's linked accounts
    const { data: contactAccounts } = await getSupabase()
      .from("contacts")
      .select("account_contacts(account_id)")
      .ilike("email", email)
      .limit(1)
    if (contactAccounts?.length) {
      const ac = contactAccounts[0].account_contacts as Array<{ account_id: string }> | null
      if (ac?.length) resolvedAccountId = ac[0].account_id
    }
  }
  if (resolvedAccountId) {
    const { upgradePortalTier, tierForContract } = await import("@/lib/portal/auto-create")
    await upgradePortalTier(resolvedAccountId, tierForContract(contractType))
  }

  // 8. Match pending_activation — use offer_token (exact) OR email (fallback)
  if (email || offerToken) {
    let pendingQuery = getSupabase()
      .from("pending_activations")
      .select("id, offer_token, lead_id")
      .eq("status", "awaiting_payment")
      .limit(1)

    // Prefer offer_token match (exact), fallback to email
    if (offerToken) {
      pendingQuery = pendingQuery.eq("offer_token", offerToken)
    } else {
      pendingQuery = pendingQuery.eq("client_email", email!)
    }

    const { data: pendingList } = await pendingQuery

    if (pendingList && pendingList.length > 0) {
      const pending = pendingList[0]
      // Optimistic locking
      const { data: updated } = await getSupabase()
        .from("pending_activations")
        .update({
          status: "payment_confirmed",
          payment_confirmed_at: new Date().toISOString(),
          payment_method: "stripe",
          whop_membership_id: paymentIntentId || sessionId, // reuse field for external ref
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending.id)
        .eq("status", "awaiting_payment")
        .select("id")

      if (!updated || updated.length === 0) {
        console.warn(`[stripe-webhook] pending_activation ${pending.id} already processed — skipping`)
        return NextResponse.json({ ok: true, message: "Already processed" })
      }

      // Update offer status to 'completed' (unlocks portal step 4)
      if (pending.offer_token) {
        await getSupabase()
          .from("offers")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("token", pending.offer_token)
          .eq("status", "signed")
      }

      // Portal tier already upgraded in step 7 above (upgradePortalTier syncs both account + contacts)

      console.warn(`[stripe-webhook] Matched pending_activation ${pending.id} — triggering activation`)

      // Log to action_log for CRM Recent Activity + realtime notifications
      try {
        await getSupabase().from("action_log").insert({
          actor: "system",
          action_type: "payment_confirmed",
          table_name: "pending_activations",
          record_id: pending.id,
          account_id: accountId || null,
          contact_id: contactId || null,
          summary: `Payment confirmed via Stripe: ${currency} ${total} — ${clientName || email || "unknown"}`,
          details: { payment_method: "stripe", amount: total, currency, email, offer_token: offerToken },
        })
      } catch { /* non-blocking */ }

      // If pending_activation has a portal_invoice_id (created at signing), mark it Paid
      const { data: activationWithInvoice } = await getSupabase()
        .from("pending_activations")
        .select("portal_invoice_id")
        .eq("id", pending.id)
        .single()

      if (activationWithInvoice?.portal_invoice_id) {
        // CARD FEE (dev_task 6ec6872a): book the fee ONTO the draft invoice from the
        // ACTUAL charge BEFORE runActivation settles it (its settle_full caps at the
        // invoice total, so the total must be base+fee first). All-or-throw: a write
        // failure propagates to a non-200 and Stripe retries from a non-terminal
        // invoice. On base-mismatch → 'overage': settle at base, raise a review.
        const { bookCardFee } = await import("@/lib/finance/card-fee-booking")
        const feeResult = await bookCardFee(activationWithInvoice.portal_invoice_id, total)
        if (feeResult.outcome === "overage") {
          const { raiseCardFeeOverageIssue } = await import("@/lib/finance/card-fee-issues")
          await raiseCardFeeOverageIssue({ paymentId: activationWithInvoice.portal_invoice_id, base: feeResult.base, charged: total, gatewayPaymentId: paymentIntentId || sessionId })
        }
      }

      // Trigger activate-service workflow directly (no HTTP hop). Settles the (now
      // fee-bumped) draft invoice via applyMoneyToInvoice → amount_paid = the actual
      // charge. Invoice is Paid on PAYMENT; if activation then fails, it stays Paid
      // and the failure raises a portal issue for staff (plan §10).
      try {
        const activateResult = await runActivation(pending.id)
        if (!activateResult.ok) {
          console.error(`[stripe-webhook] activate-service returned error: ${activateResult.error}`)

          // Create task so it doesn't get lost
          // eslint-disable-next-line no-restricted-syntax -- legacy tasks insert; tracked by dev_task 7ebb1e0c
          await getSupabase().from("tasks").insert({
            task_title: `Stripe payment: activate-service FAILED for ${clientName || email}`,
            description: `Payment ${paymentIntentId} confirmed but activate-service failed.\nError: ${activateResult.error}\nPending activation: ${pending.id}\n\nManual activation needed.`,
            assigned_to: "Antonio",
            priority: "Urgent",
            category: "Payment",
            status: "To Do",
          })
          // Paid but auto-setup failed → surface in the staff Portal Chats "!" Issue
          // tab (dev_task 6ec6872a). Deduped on the payment id across Stripe retries.
          const { raiseActivationFailedIssue } = await import("@/lib/finance/card-fee-issues")
          await raiseActivationFailedIssue({ paymentId: activationPortalInvoiceId, pendingActivationId: pending.id, clientName, email, error: activateResult.error || "activate-service failed", gatewayPaymentId: paymentIntentId || sessionId })
        }
      } catch (e) {
        console.error("[stripe-webhook] Failed to trigger activate-service:", e)

        // Create fallback task
        // eslint-disable-next-line no-restricted-syntax -- legacy tasks insert; tracked by dev_task 7ebb1e0c
        await getSupabase().from("tasks").insert({
          task_title: `Stripe payment: activate-service UNREACHABLE for ${clientName || email}`,
          description: `Payment ${paymentIntentId} confirmed but activate-service threw an exception.\nError: ${e instanceof Error ? e.message : String(e)}\nPending activation: ${pending.id}\n\nManual activation needed.`,
          assigned_to: "Antonio",
          priority: "Urgent",
          category: "Payment",
          status: "To Do",
        })
        const { raiseActivationFailedIssue } = await import("@/lib/finance/card-fee-issues")
        await raiseActivationFailedIssue({ paymentId: activationPortalInvoiceId, pendingActivationId: pending.id, clientName, email, error: e instanceof Error ? e.message : String(e), gatewayPaymentId: paymentIntentId || sessionId })
      }
    } else {
      // No pending activation — create follow-up task
      // eslint-disable-next-line no-restricted-syntax -- legacy tasks insert; tracked by dev_task 7ebb1e0c
      await getSupabase().from("tasks").insert({
        task_title: `Stripe payment received: ${clientName || email} — ${currency} ${total}`,
        description: `Session ${sessionId}, PaymentIntent ${paymentIntentId}.\nClient: ${clientName || "N/A"}\nEmail: ${email || "N/A"}\nAmount: ${currency} ${total}\nOffer: ${offerToken || "N/A"}\n\nNo pending activation found — check if contract was signed.`,
        assigned_to: "Antonio",
        priority: "High",
        category: "Payment",
        status: "To Do",
        account_id: accountId,
      })
    }
  } else {
    // No email and no offer_token — create task
    // eslint-disable-next-line no-restricted-syntax -- legacy tasks insert; tracked by dev_task 7ebb1e0c
    await getSupabase().from("tasks").insert({
      task_title: `Stripe payment received: ${clientName || "unknown"} — ${currency} ${total}`,
      description: `Session ${sessionId}.\nNo email or offer_token found.\nAmount: ${currency} ${total}`,
      assigned_to: "Antonio",
      priority: "High",
      category: "Payment",
      status: "To Do",
    })
  }

  console.warn(`[stripe-webhook] Payment processed. Account: ${accountId || "none"}, Lead: ${leadId || "none"}`)
}

// ─── Main Handler ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const signature = req.headers.get("stripe-signature") || ""

    console.warn("[stripe-webhook] Incoming request, signature present:", !!signature)

    // Verify signature
    const event = await verifyStripeSignature(body, signature)
    if (!event) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }

    console.warn(`[stripe-webhook] Received event: ${event.type}`)

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as unknown as StripeSession)
        break

      case "payment_intent.payment_failed": {
        const intent = event.data.object
        console.warn("[stripe-webhook] Payment failed:", intent.id)
        await getSupabase().from("webhook_events").insert({
          source: "stripe",
          event_type: "payment_intent.payment_failed",
          external_id: (intent.id as string) || "unknown",
          payload: intent,
        })
        break
      }

      // WS-A (dev job c0a61e44): money going BACK. Before this, nothing in the
      // system ever learned that a charge was refunded or disputed after the
      // fact — the refund check only ran at settlement time and never revisited
      // a stored row. A paid-call credit whose charge is reversed must not stay
      // spendable, so these events are now subscribed and routed.
      case "charge.refunded":
      case "charge.dispute.created": {
        const obj = event.data.object as unknown as Record<string, unknown>
        const chargeId = String(
          event.type === "charge.refunded" ? obj.id : (obj.charge ?? obj.id),
        )
        await handleChargeReversal(chargeId, event.type)
        break
      }

      default:
        console.warn(`[stripe-webhook] Unhandled event: ${event.type}`)
        await getSupabase().from("webhook_events").insert({
          source: "stripe",
          event_type: event.type,
          external_id: (event.data.object.id as string) || "unknown",
          payload: event.data.object,
        })
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[stripe-webhook] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
