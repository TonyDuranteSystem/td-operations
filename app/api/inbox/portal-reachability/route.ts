import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { checkPortalReachability } from "@/lib/portal/recipient-reachability"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/portal-reachability?type=account|contact|lead|partner&id=…
 *
 * "Can this target actually receive a portal message, and have they ever signed in?"
 * — asked the moment a client is picked on the Confirm card, so the answer is on
 * screen BEFORE the send is allowed (Antonio, 2026-08-02).
 *
 * Returns the resolved target too: picking a LEAD resolves to that person's contact,
 * because sending an offer creates the portal login against the contact. Refusing the
 * lead row while its own twin sat in the same search list was the bug this replaces.
 *
 * Read-only and staff-gated. It reports names and emails of the people who would
 * receive the message — that is the point (the staff member must see who "everyone at
 * this company" actually is) — so it must never be reachable by a client.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const type = req.nextUrl.searchParams.get("type")
  const id = req.nextUrl.searchParams.get("id")?.trim()
  if (!id || !type || !["account", "contact", "lead", "partner"].includes(type)) {
    return NextResponse.json({ error: "type and id are required" }, { status: 400 })
  }

  try {
    const result = await checkPortalReachability({ type: type as "account" | "contact" | "lead" | "partner", id })
    return NextResponse.json(result)
  } catch (err) {
    // FAILS TOWARD ALLOWING THE SEND, deliberately. A lookup outage must not silently
    // block every client message — that would be an invisible, total outage of the
    // feature. The card surfaces the unknown state instead of asserting access.
    console.warn("[portal-reachability] check failed:", err)
    return NextResponse.json({
      reachable: true,
      target: {},
      recipients: [],
      neverSignedIn: false,
      unknown: true,
    })
  }
}
