/**
 * Referral Link Redirect — /r/[code]
 *
 * Looks up contacts.referral_code, redirects to Calendly with UTM params.
 * If code not found → redirects to main website.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient, SupabaseClient } from "@supabase/supabase-js"

const CALENDLY_URL = "https://calendly.com/antoniodurante/free-meet-greet-call"
const FALLBACK_URL = "https://tonydurante.us"

// Lazy-init to avoid build-time crash
let _supabase: SupabaseClient | null = null
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _supabase
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params
  const supabase = getSupabase()

  // Case-insensitive lookup
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, full_name, referral_code")
    .ilike("referral_code", code)
    .single()

  if (!contact) {
    return NextResponse.redirect(FALLBACK_URL, { status: 302 })
  }

  // Build Calendly URL with UTM tracking
  const url = new URL(CALENDLY_URL)
  url.searchParams.set("utm_source", "referral")
  url.searchParams.set("utm_medium", "link")
  url.searchParams.set("utm_campaign", contact.referral_code)

  return NextResponse.redirect(url.toString(), { status: 302 })
}
