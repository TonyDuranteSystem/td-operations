import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { giveLeadTo } from "@/lib/marketing/give-lead"
import { leadDb } from "@/lib/marketing/meta-leads/service"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/** POST /api/marketing-admin/leads/[id]/give — body { personId }. Antonio gives a lead of a team to a person of that team who works the leads. Admin only (strict check), JSON only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = await req.json().catch(() => ({})) as { personId?: unknown }
  const { id } = await params
  const r = await giveLeadTo(leadDb(), id, typeof body.personId === "string" ? body.personId : "", user.email ?? user.id)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
