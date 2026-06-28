import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { listEnrollments } from '@/lib/td-communication/pipeline-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/projects — list all TD Communication enrollments
 * for the pipeline board. Open to staff and to any partner with the
 * td_communication scope (resolveCommParticipant gates both). Cris sees the
 * full pipeline; visibility is role-based, independent of an enrollment's subject.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const projects = await listEnrollments()
    return NextResponse.json({ projects })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load projects.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
