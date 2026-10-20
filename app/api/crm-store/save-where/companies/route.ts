/**
 * GET /api/crm-store/save-where/companies?q= — the company typeahead of the "Where should this be saved?" window. Staff only, reads only.
 * Answer: { companies: [{ accountId, name, status }] } (at most 15, name contains q; `more: true` when there are more matches than shown).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../browse/_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim()
  if (q.length < 2) return NextResponse.json({ companies: [] })
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { data, error } = await supabaseAdmin.from("accounts").select("id, company_name, status").ilike("company_name", `%${q.replace(/[\\%_]/g, "\\$&")}%`).order("company_name").limit(16)
  if (error) return NextResponse.json({ error: "Could not search the companies. Please try again." }, { status: 500 })
  const all = data ?? []
  return NextResponse.json({ more: all.length > 15, companies: all.slice(0, 15).map((a) => ({ accountId: a.id, name: a.company_name, status: a.status })) }, { headers: { "Cache-Control": "no-store" } })
}
