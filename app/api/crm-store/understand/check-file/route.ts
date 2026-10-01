/** POST { fileId, bulk? } — check ONE file with the AI (a click on the file, or one step of a company-wide check). Never changes the file.
 *  Answers { state, message, mark, budget }; state says plainly what happened (checked / skipped_personal / cap_reached / busy / …). */
export const dynamic = "force-dynamic"
export const maxDuration = 120

import { NextRequest, NextResponse } from "next/server"
import { gateAiCheck } from "../_gate"

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { fileId?: unknown; bulk?: unknown }
  const fileId = typeof body.fileId === "string" ? body.fileId : ""
  if (!fileId) return NextResponse.json({ error: "Say which file to check." }, { status: 400 })
  const g = await gateAiCheck({ fileId })
  if (g instanceof NextResponse) return g
  try {
    const { checkOneFile, budget } = await import("@/lib/crm-store/understand/ai-check")
    const outcome = await checkOneFile(fileId, g.actor, { bulk: body.bulk === true })
    return NextResponse.json({ ...outcome, budget: await budget() })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file could not be checked." }, { status: 500 })
  }
}
