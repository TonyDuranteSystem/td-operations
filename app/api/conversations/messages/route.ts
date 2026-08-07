import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  resolveCommParticipant,
  participantCanAccess,
  listMessages,
  insertMessage,
  ensureParticipant,
  markConversationRead,
  markMessagesRead,
} from '@/lib/td-communication/queries'
import { validateMessageBody } from '@/lib/td-communication/helpers'
import { logPartnerAccess } from '@/lib/td-communication/partner-access-log'
import type { CommAttachment } from '@/lib/td-communication/types'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/conversations/messages?conversation_id=…  — list a thread's messages
 *   (partner never sees soft-deleted; staff see tombstones), join the caller as a
 *   participant (so the RLS policy delivers realtime to them), mark the thread
 *   read + stamp read receipts on the counterpart's messages.
 * POST /api/conversations/messages  — send a message.
 *   Body: { conversation_id, body?, attachments?, reply_to_id? }. Body OR at
 *   least one attachment is required.
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
    const messages = await listMessages(conversationId, participant.type)
    await markConversationRead(conversationId, participant)
    await markMessagesRead(conversationId, participant)
    if (participant.type === 'partner') {
      logPartnerAccess({
        partnerId: participant.id,
        surface: 'chat_read',
        method: 'GET',
        path: '/api/conversations/messages',
        detail: { conversation_id: conversationId, messages: messages.length },
        req,
      })
    }
    return NextResponse.json({ messages })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load messages.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function parseAttachments(raw: unknown): CommAttachment[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a): a is CommAttachment => !!a && typeof a.url === 'string' && typeof a.name === 'string')
    .slice(0, 10)
    .map((a) => ({ url: a.url, name: a.name, mime_type: a.mime_type, size: a.size }))
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

  const attachments = parseAttachments(body.attachments)
  const replyToId = typeof body.reply_to_id === 'string' ? body.reply_to_id : null

  // Body is optional when there are attachments; otherwise it must be valid.
  let messageBody = ''
  if (typeof body.body === 'string' && body.body.trim()) {
    const v = validateMessageBody(body.body)
    if (v.error || v.body === null) {
      return NextResponse.json({ error: v.error ?? 'Invalid message.' }, { status: 400 })
    }
    messageBody = v.body
  } else if (attachments.length === 0) {
    return NextResponse.json({ error: 'Cannot send an empty message.' }, { status: 400 })
  }

  try {
    if (!(await participantCanAccess(conversationId, participant))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const message = await insertMessage({
      conversationId,
      sender: participant,
      body: messageBody,
      attachments,
      replyToId,
    })
    if (participant.type === 'partner') {
      logPartnerAccess({
        partnerId: participant.id,
        surface: 'chat_send',
        method: 'POST',
        path: '/api/conversations/messages',
        detail: { conversation_id: conversationId, attachments: attachments.length },
        req,
      })
    }
    return NextResponse.json({ message }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to send message.'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
