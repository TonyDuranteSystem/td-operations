/**
 * POST /api/crm-store/browse/file/<id>/filed — mark a draft return as FILED (it can then be shown to the client;
 * a filed file is frozen: no new version, only an amended file). Staff only, pilot environment only.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv())
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id })
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    const { data: f } = await (supabaseAdmin as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { needs_review_at: string | null; filing_status: string | null } | null }> } } } })
      .from("store_files").select("needs_review_at, filing_status").eq("id", params.id).maybeSingle()
    if (!f) return NextResponse.json({ error: "File not found." }, { status: 404 })
    if (f.needs_review_at) return NextResponse.json({ error: "Settle \"Needs review\" first (Mark reviewed), then mark it filed." }, { status: 400 })
    if (f.filing_status !== "draft") return NextResponse.json({ error: "Only a draft can be marked filed." }, { status: 400 })
    const { error } = await (supabaseAdmin as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ error: { message: string } | null }> })
      .rpc("store_set_filing_status", { p_file_id: params.id, p_status: "filed", p_actor: user?.id ?? null })
    if (error) return NextResponse.json({ error: error.message.replace(/^store: /, "") }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "It could not be marked filed." }, { status: 400 })
  }
}
