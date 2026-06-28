import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  resolveCommParticipant,
  listConversationsForStaff,
  listConversationsForPartner,
  createConversation,
} from '@/lib/td-communication/queries'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/conversations  — list conversations for the caller.
 *   Staff see all; a partner sees only their own.
 * POST /api/conversations  — create a conversation.
 *   Body: { subject?: string, partner_id?: string }. A partner's conversation
 *   is always tied to themselves regardless of body.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const conversations =
      participant.type === 'staff'
        ? await listConversationsForStaff()
        : await listConversationsForPartner(participant.id)
    return NextResponse.json({ conversations })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load conversations.'
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
  // Staff may target any partner; a partner can only create their own thread.
  const partnerId =
    participant.type === 'partner'
      ? participant.id
      : typeof body.partner_id === 'string'
        ? body.partner_id
        : null

  try {
    const conversation = await createConversation({
      subject: body.subject,
      partnerId,
      creator: participant,
    })
    return NextResponse.json({ conversation }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create conversation.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
