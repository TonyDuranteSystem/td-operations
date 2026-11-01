/**
 * GET /api/crm/leads/[id]/window/send-status
 *
 * Whether sending from the lead window is switched on right now (LEAD_WINDOW_SEND, lib/leads/flags.ts). The window asks
 * this at the moment of sending, so a window opened before the switch was turned off cannot keep sending. Staff only.
 */

import { NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { leadSendEnabled } from "@/lib/leads/flags"

export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await requireStaffRoute()
  if (denied) return denied
  return NextResponse.json({ enabled: leadSendEnabled() })
}
