/**
 * POST /api/crm/admin-actions/send-offer
 *
 * Admin-only. Publishes an offer to the client portal (portal-first).
 * Delegates to shared publishOffer() — same logic as MCP offer_send.
 *
 * What happens:
 *   1. Creates portal user with offer.client_email if needed
 *   2. Sends portal-access email (new user) or portal-notification email (existing user)
 *   3. Updates offer status to 'published'
 *   4. Tracks email open with pixel
 *
 * No direct offer URL is sent. Client must log into portal.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { publishOffer } from "@/lib/offers/publish"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "send_document")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    const result = await publishOffer(offer_token, "crm-admin")

    if (!result.success) {
      const status = result.alreadySent ? 409 : 400
      return NextResponse.json({ error: result.error }, { status })
    }

    return NextResponse.json({
      ok: true,
      message: `Offer published to portal for ${offer_token}`,
      portal_created: result.portalCreated,
      portal_already_existed: result.portalAlreadyExisted,
      email_type: result.emailType,
      tracking_id: result.trackingId,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
