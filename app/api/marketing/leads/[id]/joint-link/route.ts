import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { liveJointEnv } from "@/lib/marketing/joint-live"
import { createJointLink } from "@/lib/marketing/joint-booking"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing/leads/[id]/joint-link — the seller makes a booking link WITH Antonio for this lead ({ action: "create" }), and later writes in the history that he sent it ({ action: "sent", via, url }).
 * The team comes from the guard, never from the request. Never while Antonio is "viewing as" somebody: a preview must not make a real link.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing()
  if (g.res) return g.res
  if (!hasPermission(g.ctx.permissions, "leads.pick")) return NextResponse.json({ error: "You are not allowed to do this.", code: "NO_PERMISSION" }, { status: 403, headers: NO_STORE })
  if (g.ctx.viewAs !== undefined) return NextResponse.json({ error: "A link cannot be made while you are previewing as someone else." }, { status: 409, headers: NO_STORE })
  const { id } = await params
  const body = (await req.json().catch(() => null)) as { action?: unknown; via?: unknown; url?: unknown } | null
  try {
    if (body?.action === "create") {
      const r = await createJointLink(liveJointEnv(), { teamId: g.ctx.team.id, leadId: id, createdBy: g.ctx.user.email ?? g.ctx.user.id })
      if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
      return NextResponse.json({ ok: true, url: r.url, expiresAt: r.expiresAt, lang: r.lang }, { headers: NO_STORE })
    }
    if (body?.action === "sent") {
      const via = body.via === "email" ? "email" : "whatsapp"
      const url = typeof body.url === "string" && /^https:\/\/[^\s/]+\/marketing\/book\/[A-Za-z0-9_-]{40,64}$/.test(body.url) ? body.url : null
      if (!url) return NextResponse.json({ error: "That link is not valid." }, { status: 400, headers: NO_STORE })
      const { data: lead } = await leadDb().from("marketing_leads").select("id, status").eq("id", id).eq("team_id", g.ctx.team.id).maybeSingle()
      if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404, headers: NO_STORE })
      // the same history line as the usual booking link, marked as the one with Antonio; the lead is NOT moved to another stage by it
      const { error } = await leadDb().from("marketing_lead_events").insert({ lead_id: id, kind: "booking_link", actor: g.ctx.user.email ?? g.ctx.user.id, data: { url, via, joint: true, from: lead.status, to: lead.status, note: "With Antonio" } })
      if (error) return NextResponse.json({ error: "Could not save. Please try again." }, { status: 500, headers: NO_STORE })
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }
    return NextResponse.json({ error: "That request is not valid. Reload the page and try again." }, { status: 400, headers: NO_STORE })
  } catch (e) {
    console.error("[marketing] joint link create failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "Could not make the link. Please try again." }, { status: 500, headers: NO_STORE })
  }
}
