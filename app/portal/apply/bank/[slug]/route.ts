import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// Untyped view of supabaseAdmin — remove once the generated types include
// bank_referrals / bank_referral_clicks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabaseAdmin as any

// Tracked redirect for partner-bank referral links. A client clicks a link on
// the portal dashboard (e.g. "Apply at Sokin"), which hits this route; we
// record the click against their account + contact, then 302 to the bank's
// real apply URL. Using a middleman route instead of a bare <a href> is what
// gives us "did the client click yes/no" visibility in the CRM.
export async function GET(
  req: Request,
  { params }: { params: { slug: string } },
) {
  const { slug } = params

  // Fetch the referral. Even if bank is disabled or missing, fail open to
  // the portal root — no hard errors to confuse clients.
  const { data: ref } = await sb
    .from('bank_referrals')
    .select('slug, apply_url, enabled')
    .eq('slug', slug)
    .maybeSingle()

  if (!ref || !ref.enabled) {
    return NextResponse.redirect(new URL('/portal', req.url))
  }

  // Resolve who's clicking from the server-side session. Anonymous clicks
  // (link shared outside portal) still redirect but aren't attributed.
  let accountId: string | null = null
  let contactId: string | null = null
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    contactId = (user?.app_metadata?.contact_id as string | undefined) ?? null
    if (contactId) {
      const { data: ac } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id')
        .eq('contact_id', contactId)
        .limit(1)
        .maybeSingle()
      accountId = ac?.account_id ?? null
    }
  } catch {
    // Session lookup errors shouldn't block the redirect — just skip tracking.
  }

  await sb.from('bank_referral_clicks').insert({
    bank_slug: ref.slug,
    account_id: accountId,
    contact_id: contactId,
  })

  return NextResponse.redirect(ref.apply_url, { status: 302 })
}
