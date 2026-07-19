import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/thread-unread
 * Personal "mark this thread unread" — forces its dot back on for the caller
 * even though they have read it. Body: { root_id, from_message_id? }.
 *
 * With `from_message_id` this is Slack's "mark unread from here": the read
 * pointer is rewound to JUST BEFORE that message, so everything from it
 * downwards reads as new. Without it, the whole thread is simply flagged.
 *
 * Cleared when the caller next opens the thread (the thread-read route).
 * Personal — nobody else sees it. Staff-only.
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
  const fromMessageId: string | null = (body.from_message_id ?? '').toString().trim() || null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: root } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, root_id')
    .eq('id', rootId)
    .eq('thread_id', threadId)
    .single()
  if (!root) return NextResponse.json({ error: 'Thread not found in this channel.' }, { status: 404 })
  if (root.root_id) return NextResponse.json({ error: 'That is a reply, not a thread.' }, { status: 400 })

  const now = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: Record<string, any> = {
    root_message_id: rootId, user_id: user.id, manual_unread: true, updated_at: now,
  }

  if (fromMessageId) {
    // Rewind the pointer to a hair before the chosen message. It must belong to
    // THIS thread — either the root itself or one of its replies — or the caller
    // could rewind their pointer using an unrelated message's timestamp.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: target } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('id, created_at, root_id')
      .eq('id', fromMessageId)
      .eq('thread_id', threadId)
      .single()
    if (!target || (target.id !== rootId && target.root_id !== rootId)) {
      return NextResponse.json({ error: 'That message is not in this thread.' }, { status: 400 })
    }
    row.last_read_at = new Date(new Date(target.created_at).getTime() - 1).toISOString()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from('internal_root_reads')
    .upsert(row, { onConflict: 'root_message_id,user_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, unread: true, from_message_id: fromMessageId })
}
