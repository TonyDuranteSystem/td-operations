/**
 * POST — the plan-driven build (job 685467b5; owners only; its own switch STORE_PLAN_BUILD=1 outside the pilot).
 *   { plan, approvedSha, dryRun? }   dryRun defaults to TRUE: nothing is written, the answer lists every file with
 *                                    its company, folder and final name and every problem found.
 * The build itself continues through the ordinary copy routes (…/import/<runId>/continue and …/undo).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { plan?: unknown; approvedSha?: unknown; dryRun?: unknown }
  if (typeof body.approvedSha !== "string" || !/^[0-9a-f]{64}$/.test(body.approvedSha)) return NextResponse.json({ error: "approvedSha (the fingerprint of the approved plan) is required." }, { status: 400 })
  try {
    const { startPlanBuild, PlanError } = await import("@/lib/crm-store/plan-build")
    try {
      return NextResponse.json(await startPlanBuild(body.plan, { approvedSha: body.approvedSha, actorId: user.id, dryRun: body.dryRun !== false }), { headers: { "Cache-Control": "no-store" } })
    } catch (e) {
      if (e instanceof PlanError) return NextResponse.json({ error: e.message, errors: e.errors }, { status: 400 })
      throw e
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The build could not start." }, { status: 400 })
  }
}
