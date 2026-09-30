/**
 * Offer Signed Webhook
 *
 * Called by the contract page after a client signs.
 * Creates a pending_activation record to track the payment wait.
 * If the offer has Whop payment links → await Whop webhook.
 * If bank transfer → cron check-wire-payments will match it.
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyInternalWebhookSecret } from "@/lib/webhook-internal-auth"
import { processOfferSigned } from "@/lib/offers/process-offer-signed"

export async function POST(req: NextRequest) {
  // Fail CLOSED: this webhook mints a real TD invoice and rewrites offer bank
  // references. It sits on the public /api/webhooks/* path, so without a secret
  // anyone who learned a token could POST it (security audit 2026-06-13, H4).
  // Requires the internal secret; rejects when the secret is unset.
  if (!verifyInternalWebhookSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const reqBody = await req.json().catch(() => ({}))
  const offer_token = (reqBody as { offer_token?: string }).offer_token
  if (!offer_token) {
    return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
  }
  const outcome = await processOfferSigned(offer_token)
  return NextResponse.json(outcome.body, { status: outcome.status })
}
