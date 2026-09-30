/**
 * Webhook: Annual Agreement Signed
 *
 * Called by renewal-agreement.tsx (client component) after the client signs
 * their annual agreement. Verifies the signature, creates the 1st installment
 * invoice, and auto-sends it so "Pay Invoice" appears immediately in the portal.
 *
 * Idempotency key: renewal-1st:{account_id}:{agreement_year}
 * Uses agreement_year (not current year) — plan correction to avoid off-by-one
 * when agreements signed in December for the following year.
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyInternalWebhookSecret } from "@/lib/webhook-internal-auth"
import { processAgreementSigned } from "@/lib/offers/process-agreement-signed"

export async function POST(req: NextRequest) {
  // Fail CLOSED: this webhook flips an annual agreement to signed and auto-sends
  // a 1st-installment invoice. Public path → require the internal secret so a
  // bare token can't trigger it (security audit 2026-06-13, H4).
  if (!verifyInternalWebhookSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const reqBody = await req.json().catch(() => ({}))
  const agreement_token = (reqBody as { agreement_token?: string }).agreement_token
  if (!agreement_token) {
    return NextResponse.json({ error: "Missing agreement_token" }, { status: 400 })
  }
  const outcome = await processAgreementSigned(agreement_token)
  return NextResponse.json(outcome.body, { status: outcome.status })
}
