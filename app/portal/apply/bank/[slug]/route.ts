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
    .select('slug, apply_url, enabled, rep_email, label')
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

  // Check whether this is the first click for this account+bank before inserting,
  // so we can send a one-time notification to the rep.
  let isFirstClick = false
  if (accountId && ref.rep_email) {
    const { count } = await sb
      .from('bank_referral_clicks')
      .select('id', { count: 'exact', head: true })
      .eq('bank_slug', ref.slug)
      .eq('account_id', accountId)
    isFirstClick = (count ?? 0) === 0
  }

  await sb.from('bank_referral_clicks').insert({
    bank_slug: ref.slug,
    account_id: accountId,
    contact_id: contactId,
  })

  // On first click, notify the bank rep with the company and owner details.
  if (isFirstClick && ref.rep_email && accountId && contactId) {
    try {
      const [{ data: account }, { data: contact }] = await Promise.all([
        supabaseAdmin
          .from('accounts')
          .select('company_name')
          .eq('id', accountId)
          .maybeSingle(),
        supabaseAdmin
          .from('contacts')
          .select('full_name')
          .eq('id', contactId)
          .maybeSingle(),
      ])

      if (account?.company_name && contact?.full_name) {
        const { gmailPost } = await import('@/lib/gmail')
        const companyName = account.company_name
        const ownerName = contact.full_name
        const bankLabel = (ref.label as string) || slug

        const subject = `New ${bankLabel} application — ${companyName}`
        const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`

        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #18181b; padding: 20px; border-radius: 12px 12px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 18px;">New ${bankLabel} Application</h1>
            </div>
            <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
              <p style="margin: 0 0 8px;">A new client has just clicked the ${bankLabel} application link via Tony Durante's portal.</p>
              <table style="border-collapse: collapse; margin-top: 16px; width: 100%;">
                <tr>
                  <td style="padding: 8px 16px 8px 0; color: #6b7280; white-space: nowrap;">Company</td>
                  <td style="padding: 8px 0; font-weight: 600;">${companyName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 16px 8px 0; color: #6b7280; white-space: nowrap;">Owner</td>
                  <td style="padding: 8px 0; font-weight: 600;">${ownerName}</td>
                </tr>
              </table>
            </div>
          </div>
        `

        const boundary = `boundary_${Date.now()}`
        const rawEmail = [
          `From: Tony Durante <support@tonydurante.us>`,
          `To: ${ref.rep_email}`,
          `Subject: ${encodedSubject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(html).toString('base64'),
          `--${boundary}--`,
        ].join('\r\n')

        await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
      }
    } catch (err) {
      // Rep notification failure must never block the client redirect.
      console.error('[bank-referral] rep notification failed:', err)
    }
  }

  return NextResponse.redirect(ref.apply_url, { status: 302 })
}
