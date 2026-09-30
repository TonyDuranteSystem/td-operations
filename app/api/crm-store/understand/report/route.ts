/** GET ?fileId=… — what the AI found about ONE file, in plain words, for the side panel (current version only). */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { gateAiCheck } from "../_gate"

export async function GET(req: NextRequest) {
  const fileId = req.nextUrl.searchParams.get("fileId")
  if (!fileId) return NextResponse.json({ error: "Say which file." }, { status: 400 })
  const g = await gateAiCheck({ fileId })
  if (g instanceof NextResponse) return g
  try {
    const { reportForFile, budget } = await import("@/lib/crm-store/understand/ai-check")
    const report = await reportForFile(fileId)
    if (!report) return NextResponse.json({ error: "That file is no longer available." }, { status: 404 })
    return NextResponse.json({ report, budget: await budget() })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the check." }, { status: 500 })
  }
}
