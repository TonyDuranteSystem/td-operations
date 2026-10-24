import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { canSeePhone } from "@/lib/marketing/lead-privacy"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { SEARCH_LIMIT, cleanSearch, searchFilter } from "@/lib/marketing/lead-search"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * GET /api/marketing/leads/search?q=… — the workspace's search bar: this team's leads whose name, email or (for people who may see phone numbers) phone number match.
 * The team comes from the guard, never from the request. At most 8 answers, newest first; no phone number is sent to a person who may not see them.
 */
export async function GET(req: NextRequest) {
  const g = await requireMarketing("leads.read")
  if (g.res) return g.res
  const q = cleanSearch(req.nextUrl.searchParams.get("q"))
  if (!q) return NextResponse.json({ leads: [] }, { headers: NO_STORE })
  const seesPhone = canSeePhone(g.ctx.permissions)
  const { data, error } = await leadDb().from("marketing_leads")
    .select("id, full_name, email, phone, status, received_at")
    .eq("team_id", g.ctx.team.id).or(searchFilter(q, seesPhone)).order("received_at", { ascending: false }).limit(SEARCH_LIMIT)
  if (error) return NextResponse.json({ error: "Could not search. Please try again." }, { status: 500, headers: NO_STORE })
  const leads = ((data ?? []) as Array<{ id: string; full_name: string | null; email: string | null; phone: string | null; status: string }>).map(l => ({
    id: l.id, name: l.full_name || l.email || (seesPhone ? l.phone : null) || "Lead", detail: [seesPhone ? l.phone : null, l.email].filter(Boolean).join(" · "), status: l.status,
  }))
  return NextResponse.json({ leads }, { headers: NO_STORE })
}
