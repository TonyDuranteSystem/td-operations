import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { getTeam, setMarketingSetting } from "@/lib/marketing/settings"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/** The settings Antonio edits from the Settings screen (the others, such as the pipeline stages, are changed with more care elsewhere). */
const EDITABLE = new Set(["qualification_checklist", "not_in_target_reasons", "owner_may_create_offers", "owner_may_export_leads", "member_invites_need_approval", "allowed_currencies", "seller_payout_currency"])

/** PUT /api/marketing-admin/settings — body { teamId, key, value }. Antonio only (strict check), JSON only. The value is validated by the setting's own rules and every change is kept in the history. */
export async function PUT(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = await req.json().catch(() => ({})) as { teamId?: unknown; key?: unknown; value?: unknown }
  if (typeof body.key !== "string" || !EDITABLE.has(body.key)) return NextResponse.json({ error: "That setting cannot be changed here." }, { status: 400, headers: NO_STORE })
  if (typeof body.teamId !== "string" || !(await getTeam(body.teamId))) return NextResponse.json({ error: "Pick a team." }, { status: 400, headers: NO_STORE })
  const r = await setMarketingSetting({ key: body.key, value: body.value, teamId: body.teamId, actor: user.email ?? user.id })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, value: r.data }, { headers: NO_STORE })
}
