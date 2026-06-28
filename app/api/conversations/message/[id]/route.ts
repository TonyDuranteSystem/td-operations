import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  resolveCommParticipant,
  participantCanAccess,
  getMessage,
  editMessage,
  softDeleteMessage,
} from '@/lib/td-communication/queries'
import { validateMessageBody } from '@/lib/td-communication/helpers'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/conversations/message/[id] — edit a message's text (sender only).
 * DELETE /api/conversations/message/[id] — soft-delete (sender, or any staff).
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const v = validateMessageBody(body.message ?? body.body)
  if (v.error || v.body === null) {
    return NextResponse.json({ error: v.error ?? 'Invalid message.' }, { status: 400 })
  }

  try {
    const msg = await getMessage(params.id)
    if (!msg) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
    if (!(await participantCanAccess(msg.conversation_id, participant))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { changed } = await editMessage(params.id, participant, v.body)
    return NextResponse.json({ ok: true, changed })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to edit.' }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const msg = await getMessage(params.id)
    if (!msg) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
    if (!(await participantCanAccess(msg.conversation_id, participant))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    await softDeleteMessage(params.id, participant)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to delete.' }, { status: 400 })
  }
}
