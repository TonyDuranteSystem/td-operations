import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import { permissionFor } from "@/lib/marketing/lead-actions"
import { applyLeadAction, loadActionSettings, parseLeadAction } from "@/lib/marketing/lead-actions-server"
import { leadDb } from "@/lib/marketing/meta-leads/service"

const NO_STORE = { "Cache-Control": "no-store" }

/** POST /api/marketing/leads/[id]/action — pick / give back / note / Good / Not in target / Call back later. The team comes from the guard, never from the request. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing()
  if (g.res) return g.res
  const parsed = parseLeadAction(await req.json().catch(() => null))
  if (parsed.ok === false) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
  if (!hasPermission(g.ctx.permissions, permissionFor(parsed.value.action))) {
    return NextResponse.json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, { status: 403, headers: NO_STORE })
  }
  const { id } = await params
  const settings = await loadActionSettings(g.ctx.team.id)
  const r = await applyLeadAction(leadDb(), g.ctx.team.id, id, parsed.value, { id: g.ctx.user.id, email: g.ctx.user.email, role: g.ctx.role }, settings)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
