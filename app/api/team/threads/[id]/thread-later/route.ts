import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/thread-later
 * Personal "bring this thread forward" flag. Body: { root_id, later: boolean }.
 *
 * Presence of a row = flagged (mirrors internal_root_follows). Deliberately NOT
 * a column on internal_root_reads: that table's last_read_at defaults to now(),
 * so flagging a thread you have never opened would silently mark its replies
 * read. Personal to the caller — nobody else sees it. Staff-only, channels and
 * general only.
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
  const { id: threadId } = await params
  const body = await request.json().catch(() => ({}))

  const rootId: string | null = (body.root_id ?? '').toString().trim() || null
  if (!rootId) return NextResponse.json({ error: 'root_id required' }, { status: 400 })
  if (typeof body.later !== 'boolean') {
    return NextResponse.json({ error: 'later must be true or false' }, { status: 400 })
  }

  // The root must belong to this thread, and must actually BE a root — flagging
  // a reply would put a phantom row in the Later list.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: root } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, root_id')
    .eq('id', rootId)
    .eq('thread_id', threadId)
    .single()
  if (!root) return NextResponse.json({ error: 'Thread not found in this channel.' }, { status: 404 })
  if (root.root_id) return NextResponse.json({ error: 'That is a reply, not a thread.' }, { status: 400 })

  if (body.later) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from('internal_root_later')
      .upsert({ root_message_id: rootId, user_id: user.id }, { onConflict: 'root_message_id,user_id', ignoreDuplicates: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from('internal_root_later')
      .delete()
      .eq('root_message_id', rootId)
      .eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, later: body.later })
}
