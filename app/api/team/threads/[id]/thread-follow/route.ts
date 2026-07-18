import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/thread-follow
 * Follow or unfollow a thread (per-person). Body: { root_id, follow: boolean }.
 * Follow = INSERT (presence = following); unfollow = DELETE. Never touches the
 * read pointer, so following a thread you haven't opened keeps its existing
 * replies unread. Staff-only; channels/general only.
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
  const follow: boolean = body.follow !== false // default true
  if (!rootId) return NextResponse.json({ error: 'root_id required' }, { status: 400 })

  // The root must belong to this thread, and the thread must be channel/general.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id, thread_type')
    .eq('id', threadId)
    .single()
  if (!thread || (thread.thread_type !== 'channel' && thread.thread_type !== 'general')) {
    return NextResponse.json({ error: 'Threads are followed on channels only.' }, { status: 400 })
  }
  const { data: root } = await supabaseAdmin
    .from('internal_messages')
    .select('id')
    .eq('id', rootId)
    .eq('thread_id', threadId)
    .single()
  if (!root) return NextResponse.json({ error: 'thread not found in this channel' }, { status: 404 })

  if (follow) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from('internal_root_follows')
      .upsert({ root_message_id: rootId, user_id: user.id }, { onConflict: 'root_message_id,user_id', ignoreDuplicates: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from('internal_root_follows')
      .delete()
      .eq('root_message_id', rootId)
      .eq('user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, following: follow })
}
