/**
 * GET /api/accounts/:id/message-context
 *
 * Staff only. What the Accounts list's "Message" pop-up needs for one company: its chat as the only choice (pre-selected), the topics
 * already open in it, whether anybody can read it yet, and who the portal alert goes to. Read-only; the send goes through POST /api/portal/chat.
 */
import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { getAccountMessageContext } from "@/lib/portal/account-message-context"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const ctx = await getAccountMessageContext(params.id)
    if (!ctx) return NextResponse.json({ error: "Company not found" }, { status: 404 })
    return NextResponse.json(ctx)
  } catch (e) {
    console.error("[accounts/message-context]", e)
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not work out who the message can go to — please try again." }, { status: 500 })
  }
}
