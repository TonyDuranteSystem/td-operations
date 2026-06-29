import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/portal-auth'
import { resolveClientActiveEnrollment } from '@/lib/td-communication/client-access'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { canRevealConcept, currentDisclaimerVersion } from '@/lib/td-communication/disclaimer'
import { hasAcceptedDisclaimer, listReleasedConceptsForClient } from '@/lib/td-communication/disclaimer-queries'
import { resolveSubject } from '@/lib/td-communication/subject'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/td-communication/concept — the client's released brand
 * concept(s), gated behind the disclaimer. Returns NO image URLs until the
 * disclaimer is accepted (defense-in-depth: the URL is never in the response,
 * not just hidden in the page). Client-only.
 *
 *   { has_concept: false }                              — no active/revealable enrollment
 *   { has_concept: true, disclaimer_required: true }    — must accept first (no URLs)
 *   { has_concept: true, status, company_name, concepts:[{concept_number, items:[{preview_url…}]}] }
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const enrollment = await resolveClientActiveEnrollment(user)
    if (!enrollment || !canRevealConcept(enrollment.status)) {
      return NextResponse.json({ has_concept: false })
    }

    const settings = await getCommSettings()
    const version = currentDisclaimerVersion(settings)
    if (!(await hasAcceptedDisclaimer(enrollment.id, version))) {
      return NextResponse.json({ has_concept: true, disclaimer_required: true })
    }

    const [concepts, subject] = await Promise.all([
      listReleasedConceptsForClient(enrollment.id),
      resolveSubject(enrollment),
    ])
    return NextResponse.json({
      has_concept: true,
      status: enrollment.status,
      company_name: subject.name,
      concepts,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load your brand concept.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
