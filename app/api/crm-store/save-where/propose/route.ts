/**
 * POST /api/crm-store/save-where/propose — the "Where should this be saved?" window asks: given what the fax is and which company,
 * what place do the rules propose, and why? (Antonio 2026-10-20, dev job c43a8b2e.) Staff only. Reads only; saves nothing, makes no folder.
 * Body: { purpose, accountId?: string, business?: boolean, fileName }
 * Answer: { state: "proposed" | "choose" | "refused", why, path?, ownerId?, folderId?, newFolderName?, documentType? }
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../browse/_auth"

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const w = await import("@/lib/crm-store/save-where")
    if (!w.isFaxPurpose(body.purpose)) return NextResponse.json({ error: "Say what this fax is first." }, { status: 400 })
    const fileName = typeof body.fileName === "string" ? body.fileName : ""
    let company: import("@/lib/crm-store/save-where").PlaceOwnerRef | null = null
    if (body.business === true) company = { kind: "business" }
    else if (typeof body.accountId === "string" && body.accountId) {
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      const { data, error } = await supabaseAdmin.from("accounts").select("id, company_name").eq("id", body.accountId).maybeSingle()
      if (error) return NextResponse.json({ error: "Could not look up the company. Please try again." }, { status: 500 })
      if (!data) return NextResponse.json({ error: "That company was not found." }, { status: 404 })
      company = { kind: "company", accountId: data.id as string, name: (data.company_name as string | null) ?? "Company" }
    }
    const proposal = w.proposeFaxPlace({ purpose: body.purpose, company, fileName })
    const d = await import("@/lib/crm-store/save-destination")
    return NextResponse.json(await d.resolveProposal(proposal, d.realResolveDeps()), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not work out the place. Please try again." }, { status: 500 })
  }
}
