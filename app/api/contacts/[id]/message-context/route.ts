/**
 * GET /api/contacts/:id/message-context
 *
 * Staff only. Who a portal chat message to this contact can go to (their personal chat and each company) with each choice's
 * closed flag and open topics — read by the Contact page's "Message" pop-up. Read-only; the send goes through POST /api/portal/chat.
 */
import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { getContactMessageContext } from "@/lib/portal/contact-message-context"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const ctx = await getContactMessageContext(params.id)
    if (!ctx) return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    return NextResponse.json(ctx)
  } catch (e) {
    console.error("[contacts/message-context]", e)
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not work out who the message can go to — please try again." }, { status: 500 })
  }
}
