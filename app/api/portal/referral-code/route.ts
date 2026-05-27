import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getClientContactId } from "@/lib/portal-auth"
import { ensureReferralCode } from "@/lib/referral-utils"
import { APP_BASE_URL } from "@/lib/config"

export const dynamic = "force-dynamic"

// Ensures (generating on demand) and returns the signed-in client's referral code.
// Runs in a request handler — a reliable mutation context — instead of during page
// render, where writes don't persist on Vercel.
export async function GET() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: "No contact linked" }, { status: 400 })

  try {
    const code = await ensureReferralCode(contactId, supabaseAdmin)
    const link = code ? `${APP_BASE_URL}/r/${code}` : null
    return NextResponse.json({ code: code ?? null, link })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to ensure referral code"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
