import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { applyTermsNow, markPaidOut } from "@/lib/marketing/sales-server"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_paid_out"), reference: z.string().trim().min(1).max(200), paidOn: z.string().trim().min(8).max(40) }),
  z.object({ action: z.literal("apply_terms") }),
])

/** POST /api/marketing-admin/sales/[id] — Antonio marks the seller's share as paid out, or applies today's terms to a "terms not set" sale. Strict admin check, JSON only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const parsed = body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "That request is not valid. Reload the page and try again." }, { status: 400, headers: NO_STORE })
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Sale not found." }, { status: 404, headers: NO_STORE })
  const actor = user.email ?? user.id
  const r = parsed.data.action === "mark_paid_out"
    ? await markPaidOut(leadDb(), id, { reference: parsed.data.reference, paidOn: parsed.data.paidOn }, actor)
    : await applyTermsNow(leadDb(), id, actor)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
