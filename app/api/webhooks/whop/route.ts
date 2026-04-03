/**
 * Whop Webhook Endpoint
 *
 * Receives payment and membership events from Whop via Standard Webhooks.
 * Verifies signature, then:
 *   - payment.succeeded → lookup client by email, create CRM payment, set lead to "Paid", create follow-up task
 *   - membership.activated → log membership activation
 *   - membership.deactivated → log deactivation
 *
 * Whop webhook secret is base64-encoded before HMAC verification per Standard Webhooks spec.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient, SupabaseClient } from "@supabase/supabase-js"

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

// ─── Standard Webhooks Signature Verification ──────────────────────

async function verifyStandardWebhook(
  body: string,
  headers: Record<string, string>
): Promise<boolean> {
  const secret = process.env.WHOP_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[whop-webhook] WHOP_WEBHOOK_SECRET not set — skipping verification")
    return true // allow in dev, but log warning
  }

  const webhookId = headers["webhook-id"]
  const webhookTimestamp = headers["webhook-timestamp"]
  const webhookSignature = headers["webhook-signature"]

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    console.error("[whop-webhook] Missing standard webhook headers")
    return false
  }

  // Reject old timestamps (5 min tolerance)
  const ts = parseInt(webhookTimestamp, 10)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > 300) {
    console.error("[whop-webhook] Timestamp too old:", ts, "now:", now)
    return false
  }

  // Standard Webhooks: sign "msgId.timestamp.body"
  const toSign = `${webhookId}.${webhookTimestamp}.${body}`

  // Per Whop docs: the SDK does btoa(WHOP_WEBHOOK_SECRET) then Standard Webhooks
  // base64-decodes it back → HMAC key = raw UTF-8 bytes of the entire env var string
  // For whsec_ prefix: strip prefix, base64-decode the remainder
  // See: https://docs.whop.com/developer/guides/webhooks
  const encoder = new TextEncoder()
  let secretBytes: ArrayBuffer
  if (secret.startsWith("whsec_")) {
    // Standard Webhooks format: base64-encoded after prefix
    const arr = Uint8Array.from(atob(secret.slice(6)), c => c.charCodeAt(0))
    secretBytes = arr.buffer as ArrayBuffer
  } else {
    // Whop ws_ format: use raw string bytes as HMAC key (per Whop SDK: btoa(secret) → atob → bytes)
    secretBytes = encoder.encode(secret).buffer as ArrayBuffer
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(toSign))
  const sigArray = Array.from(new Uint8Array(sig))
  const computedB64 = btoa(String.fromCharCode.apply(null, sigArray))

  // webhook-signature can have multiple sigs space-separated, each prefixed with "v1,"
  const signatures = webhookSignature.split(" ")
  for (const s of signatures) {
    const [version, sigValue] = s.split(",", 2)
    if (version === "v1" && sigValue === computedB64) {
      return true
    }
  }

  console.error("[whop-webhook] Signature mismatch")
  return false
}

// ─── Event Handlers ──────────────────────────────────────────────

async function handlePaymentSucceeded(payment: Record<string, unknown>) {
  const paymentId = payment.id as string
  const _status = payment.status as string
  const total = payment.total as number
  const currency = (payment.currency as string || "usd").toUpperCase()
  const paidAt = payment.paid_at as string

  // Extract user info
  const user = payment.user as Record<string, unknown> | undefined
  const email = user?.email as string | undefined
  const username = user?.username as string | undefined

  // Extract product info
  const product = payment.product as Record<string, unknown> | undefined
  const productTitle = product?.title as string | undefined
  const _productId = product?.id as string | undefined

  // Extract billing info
  const billing = payment.billing_address as Record<string, unknown> | undefined
  const clientName = billing?.name as string | undefined

  console.warn(`[whop-webhook] payment.succeeded: ${paymentId} — ${clientName || username || email} — $${total} ${currency} — ${productTitle}`)

  // 1. Log webhook event
  await getSupabase().from("webhook_events").insert({
    source: "whop",
    event_type: "payment.succeeded",
    external_id: paymentId,
    payload: payment,
  })

  // 2. Look up client by email in CRM
  let accountId: string | null = null
  let contactId: string | null = null
  let leadId: string | null = null

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
    const { data: leads } = await getSupabase()
      .from("leads")
      .select("id")
      .ilike("email", email)
      .limit(1)

    if (leads && leads.length > 0) {
      leadId = leads[0].id
    }
  }

  // 3. Create payment record in CRM (with whop_payment_id for idempotency)
  // Check if this Whop payment was already processed
  if (paymentId) {
    const { data: existingPayment } = await getSupabase()
      .from("payments")
      .select("id")
      .eq("whop_payment_id", paymentId)
      .limit(1)
    if (existingPayment && existingPayment.length > 0) {
      console.warn(`[whop-webhook] Payment ${paymentId} already processed — skipping duplicate`)
      return NextResponse.json({ ok: true, message: "Duplicate webhook, already processed" })
    }
  }

  const paymentRecord: Record<string, unknown> = {
    amount: total,
    amount_paid: total,
    amount_currency: currency === "USD" ? "USD" : "EUR",
    paid_date: paidAt ? paidAt.split("T")[0] : new Date().toISOString().split("T")[0],
    status: "Paid",
    payment_method: "Whop",
    description: `${productTitle || "Whop payment"} — ${clientName || email || "unknown"}`,
    notes: `Whop payment ${paymentId}. Product: ${productTitle || "N/A"}.`,
    whop_payment_id: paymentId || null,
  }
  if (accountId) paymentRecord.account_id = accountId
  if (contactId) paymentRecord.contact_id = contactId

  const { error: payErr } = await getSupabase().from("payments").insert(paymentRecord)
  if (payErr) {
    console.error("[whop-webhook] Failed to create payment:", payErr.message)
  }

  // 3b. Check if this Whop payment matches an open CRM invoice (auto-reconcile)
  // Uses syncInvoiceStatus for bidirectional sync (payments ↔ client_invoices)
  if (accountId && total > 0) {
    try {
      const { data: openInvoices } = await getSupabase()
        .from("payments")
        .select("id, invoice_number, total, amount, invoice_status, portal_invoice_id")
        .eq("account_id", accountId)
        .in("invoice_status", ["Sent", "Overdue"])

      if (openInvoices?.length) {
        const today = new Date().toISOString().split("T")[0]
        const { syncInvoiceStatus } = await import("@/lib/portal/unified-invoice")

        // Try exact match first (±$1 tolerance)
        let match = openInvoices.find(inv => {
          const invAmount = Number(inv.total ?? inv.amount ?? 0)
          return Math.abs(invAmount - total) < 1
        })

        if (match) {
          console.warn(`[whop-webhook] Auto-matched Whop payment to invoice ${match.invoice_number}`)
          await syncInvoiceStatus("payment", match.id, "Paid", today, total)
        } else {
          // Fallback: partial match (Whop amount < invoice, at least 20% of invoice)
          const partialMatch = openInvoices.find(inv => {
            const invAmount = Number(inv.total ?? inv.amount ?? 0)
            return total < invAmount && total >= invAmount * 0.2
          })
          if (partialMatch) {
            console.warn(`[whop-webhook] Partial-matched Whop payment to invoice ${partialMatch.invoice_number}`)
            match = partialMatch
            await syncInvoiceStatus("payment", partialMatch.id, "Partial", today, total)
          }
        }

        if (match) {
          // Also set payment method on the payment record
          await getSupabase()
            .from("payments")
            .update({ payment_method: "Whop" })
            .eq("id", match.id)

          // QB sync (non-blocking)
          try {
            const { syncPaymentToQB } = await import("@/lib/qb-sync")
            syncPaymentToQB(match.id, { paymentDate: today, paymentMethod: "Whop" }).catch(() => {})
          } catch { /* qb-sync not critical */ }
        }
      }
    } catch (matchErr) {
      console.error("[whop-webhook] Invoice matching failed:", matchErr)
    }
  }

  // 4. Update lead status to "Converted" (payment = conversion point)
  if (leadId) {
    await getSupabase()
      .from("leads")
      .update({ status: "Converted", updated_at: new Date().toISOString() })
      .eq("id", leadId)
  }

  // 4b. Upgrade portal tier: lead → onboarding (syncs account + contacts)
  let resolvedAccountId = accountId
  if (!resolvedAccountId && email) {
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
    const { upgradePortalTier } = await import("@/lib/portal/auto-create")
    await upgradePortalTier(resolvedAccountId, "onboarding")
  }

  // 5. Check if there's a pending_activation waiting for this payment
  if (email) {
    const { data: pendingList } = await getSupabase()
      .from("pending_activations")
      .select("id, offer_token, lead_id")
      .eq("status", "awaiting_payment")
      .eq("client_email", email)
      .limit(1)

    if (pendingList && pendingList.length > 0) {
      const pending = pendingList[0]
      // Optimistic locking: only update if still awaiting_payment (prevents race with wire cron)
      const { data: updated } = await getSupabase()
        .from("pending_activations")
        .update({
          status: "payment_confirmed",
          payment_confirmed_at: new Date().toISOString(),
          payment_method: "whop",
          whop_membership_id: paymentId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending.id)
        .eq("status", "awaiting_payment")
        .select("id")

      if (!updated || updated.length === 0) {
        console.warn(`[whop-webhook] pending_activation ${pending.id} already processed — skipping`)
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

      // Portal tier already upgraded in step 4b above (upgradePortalTier syncs both account + contacts)

      console.warn(`[whop-webhook] Matched pending_activation ${pending.id} — triggering Stage 0 automation`)

      // Trigger Stage 0 activation via internal endpoint
      try {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000"
        await fetch(`${baseUrl}/api/workflows/activate-service`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.API_SECRET_TOKEN}`
          },
          body: JSON.stringify({ pending_activation_id: pending.id }),
        })
      } catch (e) {
        console.error("[whop-webhook] Failed to trigger activate-service:", e)
      }
    } else {
      // No pending activation — create follow-up task as before
      await getSupabase().from("tasks").insert({
        task_title: `Whop payment received: ${clientName || email} — $${total} ${productTitle}`,
        description: `Payment ${paymentId} received via Whop.\nClient: ${clientName || "N/A"}\nEmail: ${email || "N/A"}\nProduct: ${productTitle || "N/A"}\nAmount: $${total} ${currency}\n\nNo pending activation found — check if contract was signed.`,
        assigned_to: "Antonio",
        priority: "High",
        category: "Payment",
        status: "todo",
        account_id: accountId,
      })
    }
  } else {
    // No email — create follow-up task
    await getSupabase().from("tasks").insert({
      task_title: `Whop payment received: ${clientName || "unknown"} — $${total} ${productTitle}`,
      description: `Payment ${paymentId} received via Whop.\nNo email found.\nProduct: ${productTitle || "N/A"}\nAmount: $${total} ${currency}`,
      assigned_to: "Antonio",
      priority: "High",
      category: "Payment",
      status: "todo",
    })
  }

  console.warn(`[whop-webhook] Payment processed. Account: ${accountId || "none"}, Lead: ${leadId || "none"}`)
}

async function handleMembershipEvent(
  eventType: string,
  membership: Record<string, unknown>
) {
  const membershipId = membership.id as string
  const status = membership.status as string

  console.warn(`[whop-webhook] ${eventType}: ${membershipId} — status: ${status}`)

  // Log webhook event
  await getSupabase().from("webhook_events").insert({
    source: "whop",
    event_type: eventType,
    external_id: membershipId,
    payload: membership,
  })
}

// ─── Main Handler ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const headers = Object.fromEntries(req.headers)

    // Verify Standard Webhooks signature
    const valid = await verifyStandardWebhook(body, headers)
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }

    const payload = JSON.parse(body)
    // Whop Standard Webhooks (v1) uses "type", legacy (v2) uses "action" or "event"
    const rawEventType = (payload.type || payload.action || payload.event) as string
    const eventType = rawEventType?.replace(/\./g, "_") // normalize dots to underscores
    const data = (payload.data || payload) as Record<string, unknown>

    if (!rawEventType) {
      console.error("[whop-webhook] No event type found in payload. Keys:", Object.keys(payload).join(", "))
      await getSupabase().from("webhook_events").insert({
        source: "whop",
        event_type: "unknown_no_type",
        external_id: (payload.id || data.id || "unknown") as string,
        payload: payload,
      })
      return NextResponse.json({ ok: true, warning: "no event type" })
    }

    console.warn(`[whop-webhook] Received event: ${rawEventType} (normalized: ${eventType})`)

    switch (eventType) {
      case "payment_succeeded":
        await handlePaymentSucceeded(data)
        break

      case "payment_failed":
        console.warn("[whop-webhook] Payment failed:", data)
        await getSupabase().from("webhook_events").insert({
          source: "whop",
          event_type: "payment_failed",
          external_id: (data.id as string) || "unknown",
          payload: data,
        })
        break

      case "payment_created":
      case "payment_pending":
        console.warn(`[whop-webhook] ${eventType}:`, data)
        await getSupabase().from("webhook_events").insert({
          source: "whop",
          event_type: eventType,
          external_id: (data.id as string) || "unknown",
          payload: data,
        })
        break

      case "membership_activated":
      case "membership_deactivated":
      case "membership_went_valid":    // legacy v2 format
      case "membership_went_invalid":  // legacy v2 format
        await handleMembershipEvent(eventType, data)
        break

      case "invoice_paid":
        // Invoice paid is also a payment signal — handle like payment_succeeded
        await handlePaymentSucceeded(data)
        break

      default:
        console.warn(`[whop-webhook] Unhandled event: ${eventType}`)
        await getSupabase().from("webhook_events").insert({
          source: "whop",
          event_type: eventType || "unknown",
          external_id: (data.id as string) || "unknown",
          payload: data,
        })
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[whop-webhook] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
