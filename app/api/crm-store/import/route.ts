/**
 * "Move this company to the new storage" (job 685467b5, Stage 2 mechanics — owners only, pilot environment only).
 *   GET  ?account=<id> — may the move run here + the company's latest move (for the company page)
 *   POST { accountId } — start (or resume) the move: scans the Drive folder into the ledger
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

async function owner() {
  const { data: { user } } = await createClient().auth.getUser()
  return user && isOwnerOnly(user) ? user : null
}

export async function GET(req: NextRequest) {
  const user = await owner()
  if (!user) return NextResponse.json({ allowed: false, run: null })
  const accountId = req.nextUrl.searchParams.get("account")
  if (!accountId) return NextResponse.json({ error: "account is required" }, { status: 400 })
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  if (!pilotEnvironmentAllowed()) return NextResponse.json({ allowed: false, run: null })
  try {
    const { latestRunFor } = await import("@/lib/crm-store/drive-import")
    // the company page's panel is the real MOVE; a study copy is shown in the Drive picker, never as a move
    return NextResponse.json({ allowed: true, run: await latestRunFor(accountId, "move") }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the move." }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await owner()
  if (!user) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { accountId?: string; mode?: string }
  if (!body.accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 })
  try {
    const { startDriveImport } = await import("@/lib/crm-store/drive-import")
    // "copy" = the study copy (the client's records stay on Drive); anything else = the real move (sandbox only)
    return NextResponse.json(await startDriveImport(body.accountId, user.id, { mode: body.mode === "copy" ? "copy" : "move" }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The move could not start." }, { status: 400 })
  }
}
