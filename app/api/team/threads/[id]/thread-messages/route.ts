import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/team/threads/[id]/thread-messages?root=<rootId>
 * The root message + every reply for ONE thread, fetched by root id — used when a
 * thread is opened from the cross-channel Board but its root is older than the
 * channel's loaded message window (otherwise the pane would render empty while
 * the card claims N replies). Staff-only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: threadId } = await params
  const rootId = request.nextUrl.searchParams.get('root')
  if (!rootId) return NextResponse.json({ error: 'root required' }, { status: 400 })

  // The root must belong to this thread.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: root } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('*')
    .eq('id', rootId)
    .eq('thread_id', threadId)
    .single()
  if (!root) return NextResponse.json({ error: 'thread not found in this channel' }, { status: 404 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: replies } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('*')
    .eq('thread_id', threadId)
    .eq('root_id', rootId)
    .order('created_at', { ascending: true })

  return NextResponse.json({ messages: [root, ...((replies ?? []) as unknown[])] })
}
