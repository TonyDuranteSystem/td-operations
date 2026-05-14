/**
 * GET /api/crm/admin-actions/offer-welcome-link?token=<offer_token>
 *
 * Returns the most recent welcome-link URL associated with this offer so the
 * CRM offer panel can render a "Copy Welcome Link" button. Returns
 * `{ welcome_url: null }` if no token exists yet (e.g. existing-user offer
 * where no temp password was issued).
 *
 * Read-only — gated by `view_data`.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { findWelcomeTokenBySource } from "@/lib/portal/welcome-token"

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "view_data")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const token = request.nextUrl.searchParams.get("token")
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 })
  }

  try {
    const link = await findWelcomeTokenBySource("offer", token)
    if (!link) {
      return NextResponse.json({ welcome_url: null })
    }
    return NextResponse.json({
      welcome_url: link.welcomeUrl,
      expires_at: link.expires_at,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
