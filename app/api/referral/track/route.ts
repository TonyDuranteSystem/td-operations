import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

// Logs a referral-link click. Called by the landing page (client-side) instead of
// writing during render, which does not persist on Vercel. Best-effort + fail-safe.
export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json().catch(() => ({ code: null }))
    if (!code || typeof code !== "string") {
      return NextResponse.json({ ok: false }, { status: 400 })
    }

    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, referral_code")
      .ilike("referral_code", code)
      .maybeSingle()
    if (!contact) return NextResponse.json({ ok: true, logged: false })

    await supabaseAdmin.from("referral_clicks").insert({
      referral_code: code,
      referrer_contact_id: contact.id,
      user_agent: req.headers.get("user-agent"),
      referer: req.headers.get("referer"),
    })
    return NextResponse.json({ ok: true, logged: true })
  } catch {
    return NextResponse.json({ ok: true, logged: false })
  }
}
