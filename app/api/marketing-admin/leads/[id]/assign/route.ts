import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { assignLeadToTeam } from "@/lib/marketing/admin-leads"
import { leadDb } from "@/lib/marketing/meta-leads/service"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/** POST /api/marketing-admin/leads/[id]/assign — body { teamId }. Gives a lead with no team to a team. Admin only (strict check), JSON only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = await req.json().catch(() => ({})) as { teamId?: unknown }
  const { id } = await params
  const r = await assignLeadToTeam(leadDb(), id, typeof body.teamId === "string" ? body.teamId : "", user.email ?? user.id)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
