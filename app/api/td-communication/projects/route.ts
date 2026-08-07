import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { listEnrollments, listEnrollmentsForWorkerPartner } from '@/lib/td-communication/pipeline-queries'
import { logPartnerAccess } from '@/lib/td-communication/partner-access-log'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/projects — the pipeline board data.
 * Staff see everything. A PARTNER sees ONLY enrollments assigned to them
 * (worker_partner_id) — Antonio 2026-08-07, REVERSING the earlier
 * "Cris sees the full pipeline" decision: the unscoped list resolved every
 * client/account/lead subject in the system to a partner login.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    let projects
    if (participant.type === 'partner') {
      projects = await listEnrollmentsForWorkerPartner(participant.id)
      logPartnerAccess({
        partnerId: participant.id,
        surface: 'projects_list',
        method: 'GET',
        path: '/api/td-communication/projects',
        detail: { count: projects.length },
      })
    } else {
      projects = await listEnrollments()
    }
    return NextResponse.json({ projects })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load projects.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
