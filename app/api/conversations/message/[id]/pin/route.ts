import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant, participantCanAccess, getMessage, setPinned } from '@/lib/td-communication/queries'

export const dynamic = 'force-dynamic'

/** POST /api/conversations/message/[id]/pin — Body { pinned: boolean }. Any participant. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const pinned = body.pinned !== false
  try {
    const msg = await getMessage(params.id)
    if (!msg) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
    if (!(await participantCanAccess(msg.conversation_id, participant))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    await setPinned(params.id, pinned, participant)
    return NextResponse.json({ ok: true, pinned })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to pin.' }, { status: 400 })
  }
}
