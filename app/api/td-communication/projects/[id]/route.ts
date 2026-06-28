import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { getEnrollment, setEnrollmentStatus } from '@/lib/td-communication/pipeline-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/projects/[id] — creative-brief detail for one
 * enrollment (resolved subject, linked SD snapshot, timeline). Staff or scoped
 * partner.
 */
export async function GET(
  _req: Request,
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
    const result = await setEnrollmentStatus(params.id, status)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update status.'
    const status_code = message === 'Enrollment not found.' ? 404 : message === 'Invalid status.' ? 400 : 500
    return NextResponse.json({ error: message }, { status: status_code })
  }
}
