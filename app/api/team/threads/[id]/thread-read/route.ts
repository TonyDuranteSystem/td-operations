import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/thread-read
 * Advance the caller's per-thread (per-root) read pointer — called when a Slack
 * thread pane is opened. Body: { root_id }. This is what clears a specific
 * thread's unread-replies dot WITHOUT clearing the whole channel (the reverse
 * would let unopened threads' replies get silently marked read). Staff-only.
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
  await params // thread id not needed beyond auth scoping; root_id is the grain
  const body = await request.json().catch(() => ({}))
  const rootId: string | null = (body.root_id ?? '').toString().trim() || null
  if (!rootId) return NextResponse.json({ error: 'root_id required' }, { status: 400 })

  const now = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from('internal_root_reads')
    .upsert(
      // manual_unread MUST be cleared here: opening the thread is exactly what
      // undoes a hand-marked unread (mirrors the conversation-level read route).
      { root_message_id: rootId, user_id: user.id, last_read_at: now, manual_unread: false, updated_at: now },
      { onConflict: 'root_message_id,user_id' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
