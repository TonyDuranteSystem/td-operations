import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { getEnrollment } from '@/lib/td-communication/pipeline-queries'

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
