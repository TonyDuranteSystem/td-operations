/**
 * GET /api/crm/admin-actions/incoming-payments/marketing-leads?q=<a few letters of a name or email>
 *
 * The picker behind "Marketing sale" in Calendar → Payments to confirm: marketing leads matching the text, each with the kinds of sale
 * its team offers. Staff only (same permission as confirming). Read-only. `available: false` when this database has no marketing tables.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { searchMarketingLeads } from "@/lib/incoming-payments/load"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!canPerform(user, "confirm_payment")) return NextResponse.json({ error: "You do not have permission to confirm payments." }, { status: 403 })
  const q = new URL(request.url).searchParams.get("q") ?? ""
  try {
    return NextResponse.json(await searchMarketingLeads(q), { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not search the marketing leads." }, { status: 500 })
  }
}
