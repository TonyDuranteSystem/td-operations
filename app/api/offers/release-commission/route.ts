/**
 * Release a referrer's commission OR a managed partner's payout on a payment-plan deal.
 *
 * POST /api/offers/release-commission
 *   body: { offer_token: string }
 *
 * The release itself — eligibility re-check, the atomic claim, both rails, the rollback — lives in
 * `lib/offers/release-plan-commission.ts` (`releasePlanCommission`), shared with the 15-minute automatic sweep
 * (dev job e71d786c). This file only checks the login and answers.
 *
 * Dashboard-only, same gate as the sibling manual-credit action (`/api/referral/[id]/issue-credit`).
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { releasePlanCommission } from "@/lib/offers/release-plan-commission"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const offerToken: string | undefined = typeof body?.offer_token === "string" ? body.offer_token : undefined
  if (!offerToken) return NextResponse.json({ error: "offer_token is required" }, { status: 400 })

  const result = await releasePlanCommission(offerToken)
  return NextResponse.json(result.body, { status: result.status })
}
