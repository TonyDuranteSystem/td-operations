import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { searchRecipients } from "@/lib/inbox/recipient-search"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/recipients-search?q=term
 *
 * Autocomplete for the email composer's To field: every address in the CRM
 * (contacts incl. secondary/alt addresses, members, partners, leads, account
 * communication emails) plus the Inbox correspondence index. Returns firm-wide
 * names/addresses off the service-role client, so STAFF ONLY — middleware only
 * guarantees "is logged in" for /api/* and a portal client has a login.
 *
 * Distinct from /api/inbox/contacts-search, which is the WhatsApp picker
 * (phone-holders only) and stays untouched.
 */
export async function GET(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? ""
  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] })
  }

  try {
    const suggestions = await searchRecipients(q)
    return NextResponse.json({ suggestions })
  } catch (error) {
    console.error("[recipients-search] failed:", error)
    // Autocomplete is assistive — an empty list, never a composer-breaking 500.
    return NextResponse.json({ suggestions: [] })
  }
}
