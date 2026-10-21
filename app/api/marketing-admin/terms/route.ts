import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { addCommissionTerm, getTeam } from "@/lib/marketing/settings"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

const body = z.object({
  teamId: z.string().uuid(),
  kind: z.string().trim().min(1).max(40),
  sellerPct: z.number().min(0).max(100),
  payeeAccountId: z.string().uuid().nullish(),
})

/** POST /api/marketing-admin/terms — Antonio sets a new split for a kind of sale. It applies to FUTURE links only; old sales keep what they were sold under. Strict admin check, JSON only. */
export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const parsed = body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Pick a kind and a share between 0 and 100." }, { status: 400, headers: NO_STORE })
  if (!(await getTeam(parsed.data.teamId))) return NextResponse.json({ error: "Pick a team." }, { status: 400, headers: NO_STORE })
  const r = await addCommissionTerm({ teamId: parsed.data.teamId, kind: parsed.data.kind, sellerPct: parsed.data.sellerPct, payeeAccountId: parsed.data.payeeAccountId ?? null, actor: user.email ?? user.id })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
