/**
 * Activate Service — Universal Post-Payment Automation
 *
 * Thin HTTP wrapper around lib/operations/activate-service.ts::runActivation.
 * All business logic lives in the lib function so callers can invoke it directly
 * without an HTTP hop (eliminates the class of failures where Vercel returns an
 * HTML error page instead of JSON, causing res.json() to throw and leaving clients
 * stuck in payment_confirmed state).
 *
 * Triggered when payment is confirmed (Whop webhook, Stripe webhook, or admin
 * confirm-payment action).
 */

// Added 2026-04-14 P0.7: protect complex bundled activations (15+ sequential
// steps) from mid-execution Vercel timeout. Without this, a partial failure
// left clients half-activated with no visible alert.
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { runActivation } from "@/lib/operations/activate-service"

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization")
  const token = authHeader?.replace("Bearer ", "")
  if (token !== process.env.API_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const { pending_activation_id } = body

  if (!pending_activation_id) {
    return NextResponse.json({ error: "Missing pending_activation_id" }, { status: 400 })
  }

  try {
    const result = await runActivation(pending_activation_id)
    if (!result.ok && result.status) {
      return NextResponse.json({ error: result.error, ...result }, { status: result.status })
    }
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[activate-service] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
