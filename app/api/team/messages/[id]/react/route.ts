import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/messages/[id]/react  — toggle an emoji reaction.
 * Body: { emoji }. Uses the toggle_internal_message_reaction RPC (atomic
 * add/remove keyed on emoji + reactor). Staff-only. Reactor id = auth user id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: msgId } = await params
  const body = await request.json().catch(() => ({}))
  const emoji: string = (body.emoji ?? '').toString().trim()
  if (!emoji || emoji.length > 16) {
    return NextResponse.json({ error: 'A valid emoji is required.' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any).rpc('toggle_internal_message_reaction', {
    p_message_id: msgId,
    p_emoji: emoji,
    p_reactor_id: user.id,
    p_reactor_name: getUserDisplayName(user),
  })
  if (error) {
    if ((error as { message?: string }).message?.includes('message_not_found')) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json(data)
}
