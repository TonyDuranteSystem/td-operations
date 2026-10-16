/**
 * Drive-vs-storage gap check (owners only; dev job ad09ea91). READ-ONLY — nothing is written to Drive, to storage or to the CRM.
 *   GET            — the companies in storage that still have an old Drive folder to compare
 *   GET ?account=  — one company: its Drive files, and which of them storage / the CRM do not have
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  try {
    const accountId = req.nextUrl.searchParams.get("account")
    if (!accountId) {
      const { listGapCompanies } = await import("@/lib/crm-store/drive-gap")
      const companies = (await listGapCompanies()).map(({ accountId: id, company }) => ({ accountId: id, company }))
      return NextResponse.json({ companies }, { headers: { "Cache-Control": "no-store" } })
    }
    const { scanCompanyGap } = await import("@/lib/crm-store/drive-gap")
    return NextResponse.json(await scanCompanyGap(accountId), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The Drive check could not run." }, { status: 500 })
  }
}
