import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant, participantCanAccess, getMessage, setKeptUnread } from '@/lib/td-communication/queries'

export const dynamic = 'force-dynamic'

/** POST /api/conversations/message/[id]/keep-unread — Body { kept: boolean }. Recipient re-marks unread. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const kept = body.kept !== false
  try {
    const msg = await getMessage(params.id)
    if (!msg) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
    if (!(await participantCanAccess(msg.conversation_id, participant))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    await setKeptUnread(params.id, kept)
    return NextResponse.json({ ok: true, kept })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed.' }, { status: 400 })
  }
}
