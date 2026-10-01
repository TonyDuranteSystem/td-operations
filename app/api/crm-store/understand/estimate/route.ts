/** GET ?ownerId=… or ?folderId=… — what a company-wide / folder check would read: how many files, what it costs, what is left of today's budget,
 *  which ids to check one by one. Reads nothing from the AI and changes nothing. */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { gateAiCheck } from "../_gate"

export async function GET(req: NextRequest) {
  const ownerId = req.nextUrl.searchParams.get("ownerId")
  const folderId = req.nextUrl.searchParams.get("folderId")
  if (!ownerId && !folderId) return NextResponse.json({ error: "Say which storage or folder." }, { status: 400 })
  const g = await gateAiCheck({ ownerId, folderId })
  if (g instanceof NextResponse) return g
  try {
    const { checkableFiles, budget, estimateUsd } = await import("@/lib/crm-store/understand/ai-check")
    const c = await checkableFiles({ ownerId: ownerId ?? undefined, folderId: folderId ?? undefined })
    return NextResponse.json({ ...c, count: c.fileIds.length, estimateUsd: estimateUsd(c.fileIds.length), budget: await budget() })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not work out what to check." }, { status: 500 })
  }
}
