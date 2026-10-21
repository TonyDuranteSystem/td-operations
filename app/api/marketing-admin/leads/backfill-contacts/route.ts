import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { runContactBackfill } from "@/lib/marketing/meta-leads/backfill"
import { leadDb } from "@/lib/marketing/meta-leads/service"

export const dynamic = "force-dynamic"
export const maxDuration = 60
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/leads/backfill-contacts — fills in the name, email and phone of leads stored without them, from the answers kept with each
 * lead. Body { apply: false } (default) only COUNTS; { apply: true } writes. Admin only (the strict check). JSON only, so a form on another site cannot trigger it.
 */
export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = await req.json().catch(() => ({})) as { apply?: unknown }
  try {
    return NextResponse.json({ ok: true, report: await runContactBackfill(leadDb(), { apply: body.apply === true }) }, { headers: NO_STORE })
  } catch (e) {
    console.error("[marketing-leads] backfill failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "The check could not run. Please try again." }, { status: 500, headers: NO_STORE })
  }
}
