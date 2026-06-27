import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  resolveCommParticipant,
  participantCanAccess,
  listMessages,
  insertMessage,
  ensureParticipant,
  markConversationRead,
} from '@/lib/td-communication/queries'
import { validateMessageBody } from '@/lib/td-communication/helpers'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/conversations/messages?conversation_id=…  — list a thread's
 *   messages (excludes soft-deleted), join the caller as a participant (so the
 *   comm_messages RLS policy delivers realtime to them), and mark it read.
 * POST /api/conversations/messages  — send a message.
 *   Body: { conversation_id: string, body: string }.
 *
 * Both enforce participantCanAccess: staff reach every thread, a partner only
 * their own.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const conversationId = req.nextUrl.searchParams.get('conversation_id')
  if (!conversationId) {
    return NextResponse.json({ error: 'conversation_id is required.' }, { status: 400 })
  }

  try {
    if (!(await participantCanAccess(conversationId, participant))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    await ensureParticipant(conversationId, participant)
    const messages = await listMessages(conversationId)
    await markConversationRead(conversationId, participant)
    return NextResponse.json({ messages })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load messages.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null
  if (!conversationId) {
    return NextResponse.json({ error: 'conversation_id is required.' }, { status: 400 })
  }

  const { body: messageBody, error: validationError } = validateMessageBody(body.body)
  if (validationError || messageBody === null) {
    return NextResponse.json({ error: validationError ?? 'Invalid message.' }, { status: 400 })
  }

  try {
    if (!(await participantCanAccess(conversationId, participant))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const message = await insertMessage({
      conversationId,
      sender: participant,
      body: messageBody,
    })
    return NextResponse.json({ message }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to send message.'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
