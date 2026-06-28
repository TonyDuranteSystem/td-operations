import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { updateEnrollmentNotes } from '@/lib/td-communication/pipeline-queries'

export const dynamic = 'force-dynamic'

const MAX_NOTES_LENGTH = 10_000

/**
 * PATCH /api/td-communication/projects/[id]/notes — save Cris's private notes
 * for an enrollment. Body: { notes: string }. Staff or scoped partner.
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

  const raw = (body as { notes?: unknown })?.notes
  if (typeof raw !== 'string') {
    return NextResponse.json({ error: 'Notes must be a string.' }, { status: 400 })
  }
  if (raw.length > MAX_NOTES_LENGTH) {
    return NextResponse.json(
      { error: `Notes are too long (${raw.length} characters, max ${MAX_NOTES_LENGTH}).` },
      { status: 400 },
    )
  }

  try {
    const result = await updateEnrollmentNotes(params.id, raw)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save notes.'
    const status = message === 'Enrollment not found.' ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
