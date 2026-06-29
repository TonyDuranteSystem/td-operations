import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/portal-auth'
import { resolveClientActiveEnrollment } from '@/lib/td-communication/client-access'
import { getCommSettings } from '@/lib/td-communication/comm-settings'
import { canRevealConcept, canApproveConcept, currentDisclaimerVersion } from '@/lib/td-communication/disclaimer'
import { hasAcceptedDisclaimer } from '@/lib/td-communication/disclaimer-queries'
import { approveConcept, requestDiscussion } from '@/lib/td-communication/concept-actions'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/td-communication/approve — the client's response to a revealed
 * concept. Body: { decision: 'approve' | 'discuss' }. Client-only; requires the
 * disclaimer to have been accepted (current version) on a revealable enrollment.
 *   approve  → enrollment → 'approved' + "Client approved the concept" in the project chat.
 *   discuss  → "Client wants to discuss the concept" in the project chat (no status change);
 *              returns redirect:'/portal/chat' so the client lands on their own channel.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'discuss') {
    return NextResponse.json({ error: 'Unknown decision.' }, { status: 400 })
  }

  try {
    const enrollment = await resolveClientActiveEnrollment(user)
    if (!enrollment || !canRevealConcept(enrollment.status)) {
      return NextResponse.json({ error: 'No brand concept is ready to respond to.' }, { status: 404 })
    }

    // Must have accepted the current disclaimer before acting on the concept.
    const version = currentDisclaimerVersion(await getCommSettings())
    if (!(await hasAcceptedDisclaimer(enrollment.id, version))) {
      return NextResponse.json({ error: 'Please accept the disclaimer first.' }, { status: 403 })
    }

    if (decision === 'discuss') {
      await requestDiscussion(enrollment)
      return NextResponse.json({ status: enrollment.status, redirect: '/portal/chat' })
    }

    // approve
    if (!canApproveConcept(enrollment.status)) {
      // Already approved (or otherwise not approvable) — treat as a no-op success.
      return NextResponse.json({ status: enrollment.status })
    }
    const { status } = await approveConcept(enrollment)
    return NextResponse.json({ status })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not record your response. Please try again.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
