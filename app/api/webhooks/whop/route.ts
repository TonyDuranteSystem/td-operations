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
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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

  // Secret from Whop starts with "ws_" prefix — strip it and base64-decode
  const secretBase64 = secret.startsWith("whsec_")
    ? secret.slice(6)
    : secret.startsWith("ws_")
      ? secret.slice(3)
      : secret

  // Decode base64 secret
  const secretBytes = Uint8Array.from(atob(secretBase64), c => c.charCodeAt(0))

  const encoder = new TextEncoder()
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
  const status = payment.status as string
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
  const productId = product?.id as string | undefined

  // Extract billing info
  const billing = payment.billing_address as Record<string, unknown> | undefined
  const clientName = billing?.name as string | undefined

  console.log(`[whop-webhook] payment.succeeded: ${paymentId} — ${clientName || username || email} — $${total} ${currency} — ${productTitle}`)

  // 1. Log webhook event
  await supabase.from("webhook_events").insert({
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
    const { data: contacts } = await supabase
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
    const { data: leads } = await supabase
      .from("leads")
      .select("id")
      .ilike("email", email)
      .limit(1)

    if (leads && leads.length > 0) {
      leadId = leads[0].id
    }
  }

  // 3. Create payment record in CRM
  const paymentRecord: Record<string, unknown> = {
    amount: total,
    amount_paid: total,
    amount_currency: currency === "USD" ? "USD" : "EUR",
    paid_date: paidAt ? paidAt.split("T")[0] : new Date().toISOString().split("T")[0],
    status: "paid",
    payment_method: "Whop",
    description: `${productTitle || "Whop payment"} — ${clientName || email || "unknown"}`,
    notes: `Whop payment ${paymentId}. Product: ${productTitle || "N/A"}.`,
  }
  if (accountId) paymentRecord.account_id = accountId
  if (contactId) paymentRecord.contact_id = contactId

  const { error: payErr } = await supabase.from("payments").insert(paymentRecord)
  if (payErr) {
    console.error("[whop-webhook] Failed to create payment:", payErr.message)
  }

  // 4. Update lead status to "Paid" (conversion happens after onboarding review)
  if (leadId) {
    await supabase
      .from("leads")
      .update({ status: "Paid", updated_at: new Date().toISOString() })
      .eq("id", leadId)
  }

  // 5. Create task for follow-up
  await supabase.from("tasks").insert({
    task_title: `Whop payment received: ${clientName || email} — $${total} ${productTitle}`,
    description: `Payment ${paymentId} received via Whop.\nClient: ${clientName || "N/A"}\nEmail: ${email || "N/A"}\nProduct: ${productTitle || "N/A"}\nAmount: $${total} ${currency}\n\nNext steps: Send onboarding/formation form link.`,
    assigned_to: "Antonio",
    priority: "High",
    category: "Payment",
    status: "todo",
    account_id: accountId,
  })

  console.log(`[whop-webhook] Payment processed. Account: ${accountId || "none"}, Lead: ${leadId || "none"}, Task created.`)
}

async function handleMembershipEvent(
  eventType: string,
  membership: Record<string, unknown>
) {
  const membershipId = membership.id as string
  const status = membership.status as string

  console.log(`[whop-webhook] ${eventType}: ${membershipId} — status: ${status}`)

  // Log webhook event
  await supabase.from("webhook_events").insert({
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
    // Whop v1 uses underscores (payment_succeeded), normalize to support both formats
    const rawEventType = (payload.type || payload.event) as string
    const eventType = rawEventType?.replace(/\./g, "_") // normalize dots to underscores
    const data = (payload.data || payload) as Record<string, unknown>

    console.log(`[whop-webhook] Received event: ${rawEventType} (normalized: ${eventType})`)

    switch (eventType) {
      case "payment_succeeded":
        await handlePaymentSucceeded(data)
        break

      case "payment_failed":
        console.log("[whop-webhook] Payment failed:", data)
        await supabase.from("webhook_events").insert({
          source: "whop",
          event_type: "payment_failed",
          external_id: (data.id as string) || "unknown",
          payload: data,
        })
        break

      case "payment_created":
      case "payment_pending":
        console.log(`[whop-webhook] ${eventType}:`, data)
        await supabase.from("webhook_events").insert({
          source: "whop",
          event_type: eventType,
          external_id: (data.id as string) || "unknown",
          payload: data,
        })
        break

      case "membership_activated":
      case "membership_deactivated":
        await handleMembershipEvent(eventType, data)
        break

      case "invoice_paid":
        // Invoice paid is also a payment signal — handle like payment_succeeded
        await handlePaymentSucceeded(data)
        break

      default:
        console.log(`[whop-webhook] Unhandled event: ${eventType}`)
        await supabase.from("webhook_events").insert({
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
