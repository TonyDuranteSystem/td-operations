import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isClient, getClientContactId } from '@/lib/portal-auth'
import { clientIp, userAgent } from '@/lib/esign/request-meta'
import { resolveClientActiveEnrollment } from '@/lib/td-communication/client-access'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { canRevealConcept, currentDisclaimerVersion } from '@/lib/td-communication/disclaimer'
import { recordDisclaimerAcceptance } from '@/lib/td-communication/disclaimer-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/td-communication/disclaimer — log the client's click-to-accept
 * of the brand-concept disclaimer. Client-only (the acceptance is the client's
 * own legal act — staff/admin may not accept on their behalf; mirrors the
 * tax-financials attest route). IP + user-agent are read server-side, never from
 * the body. Version is recomputed server-side from Settings, never trusted from
 * the client. Idempotent: a re-accept of the same version returns { already:true }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const enrollment = await resolveClientActiveEnrollment(user)
    if (!enrollment || !canRevealConcept(enrollment.status)) {
      return NextResponse.json({ error: 'No brand concept is ready to view.' }, { status: 404 })
    }

    const settings = await getCommSettings()
    const version = currentDisclaimerVersion(settings)
    const { already } = await recordDisclaimerAcceptance({
      enrollmentId: enrollment.id,
      contactId: getClientContactId(user),
      version,
      ipAddress: clientIp(req),
      userAgent: userAgent(req),
      method: 'click',
    })
    return NextResponse.json({ ok: true, already })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not record your acceptance. Please try again.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
