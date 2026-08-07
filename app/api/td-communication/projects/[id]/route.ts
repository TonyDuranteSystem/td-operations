import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { getEnrollment, setEnrollmentStatus } from '@/lib/td-communication/pipeline-queries'
import { logPartnerAccess, logPartnerFileGrants } from '@/lib/td-communication/partner-access-log'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/projects/[id] — creative-brief detail for one
 * enrollment (resolved subject, linked SD snapshot, timeline, SIGNED document
 * urls). Staff see any; a PARTNER only their assigned enrollments
 * (worker_partner_id — Antonio 2026-08-07; before this check any partner could
 * open ANY brief by id, including passport/ID document links). Unassigned or
 * foreign ids answer 404 so existence is not leaked. Partner opens are audit-
 * logged, with one explicit row per signed document (job 5f534ed9).
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const project = await getEnrollment(params.id)
    if (!project) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
    }
    if (participant.type === 'partner') {
      if (project.worker_partner_id !== participant.id) {
        return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      }
      logPartnerAccess({
        partnerId: participant.id,
        surface: 'project_brief',
        method: 'GET',
        path: `/api/td-communication/projects/${params.id}`,
        detail: { enrollment_id: params.id, files: project.upload_paths.length },
        req,
      })
      logPartnerFileGrants(participant.id, params.id, project.upload_paths, req)
    }
    return NextResponse.json({ project })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load project.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * PATCH /api/td-communication/projects/[id] — manual pipeline-status control for
 * the brief panel (board advancement was deferred to the deliverables manager).
 * Body: { status }. Staff or scoped partner.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  const status = (body as { status?: unknown })?.status
  if (typeof status !== 'string') {
    return NextResponse.json({ error: 'status is required.' }, { status: 400 })
  }

  try {
    // Same partner scoping as GET: a partner may only move THEIR enrollments
    // (and the attempt is audit-logged either way).
    if (participant.type === 'partner') {
      const project = await getEnrollment(params.id)
      if (!project || project.worker_partner_id !== participant.id) {
        return NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      }
      logPartnerAccess({
        partnerId: participant.id,
        surface: 'project_status_change',
        method: 'PATCH',
        path: `/api/td-communication/projects/${params.id}`,
        detail: { enrollment_id: params.id, new_status: status },
        req,
      })
    }
    const result = await setEnrollmentStatus(params.id, status)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update status.'
    const status_code = message === 'Enrollment not found.' ? 404 : message === 'Invalid status.' ? 400 : 500
    return NextResponse.json({ error: message }, { status: status_code })
  }
}
