/** GET ?owner=<owner id>&ids=a,b,c (≤200) — the AI marks for those files, derived now from each file's CURRENT version and type.
 *  Every id must belong to the named storage (a mismatch is refused), and the login must be allowed to open that storage. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { gateAiCheck } from "../_gate"

export async function GET(req: NextRequest) {
  const ownerId = req.nextUrl.searchParams.get("owner")
  const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean)
  if (!ownerId || ids.length === 0) return NextResponse.json({ marks: {} })
  if (ids.length > 200) return NextResponse.json({ error: "Too many files at once." }, { status: 400 })
  const g = await gateAiCheck({ ownerId })
  if (g instanceof NextResponse) return g
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
  const { data } = await (supabaseAdmin as any).from("store_files").select("id, owner_id").in("id", ids)
  const own = ((data ?? []) as { id: string; owner_id: string }[]).filter((r) => r.owner_id === ownerId).map((r) => r.id)
  try {
    const { marksForFiles } = await import("@/lib/crm-store/understand/ai-check")
    const m = await marksForFiles(own)
    return NextResponse.json({ marks: Object.fromEntries(Array.from(m.entries())) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the checks." }, { status: 500 })
  }
}
