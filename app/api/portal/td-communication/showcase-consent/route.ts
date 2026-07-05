import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isClient, getClientContactId } from '@/lib/portal-auth'
import { clientIp, userAgent } from '@/lib/esign/request-meta'
import { resolveClientActiveEnrollment } from '@/lib/td-communication/client-access'
import {
  currentShowcaseConsentVersion,
  grantShowcaseConsent,
  withdrawShowcaseConsent,
} from '@/lib/td-communication/showcase-consent'
import { unpublishEntriesForEnrollment } from '@/lib/td-communication/portfolio-queries'

export const dynamic = 'force-dynamic'

/**
 * POST   — the client opts IN to being featured in the public portfolio.
 * DELETE — the client WITHDRAWS: revoke the consent AND auto-unpublish + clean the
 *          public images of any linked portfolio entries (withdrawal is stricter
 *          than the soft grant — a documented "stop showing mine" must take effect).
 *
 * Client-only (the consent is the client's own act — staff/admin may not consent on
 * their behalf, mirroring the disclaimer route). The client never supplies an
 * enrollment id — resolveClientActiveEnrollment resolves THEIR OWN project (no
 * IDOR). IP/user-agent are read server-side; the version is recomputed server-side.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const enrollment = await resolveClientActiveEnrollment(user)
    if (!enrollment) {
      return NextResponse.json({ error: 'No branding project found.' }, { status: 404 })
    }
    const { already } = await grantShowcaseConsent({
      enrollmentId: enrollment.id,
      contactId: getClientContactId(user),
      version: currentShowcaseConsentVersion(),
      ipAddress: clientIp(req),
      userAgent: userAgent(req),
      method: 'click',
    })
    return NextResponse.json({ ok: true, already })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not record your choice. Please try again.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const enrollment = await resolveClientActiveEnrollment(user)
    if (!enrollment) {
      return NextResponse.json({ error: 'No branding project found.' }, { status: 404 })
    }
    await withdrawShowcaseConsent(enrollment.id)
    const { unpublished } = await unpublishEntriesForEnrollment(enrollment.id)
    return NextResponse.json({ ok: true, unpublished })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not record your choice. Please try again.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
