import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/later
 * Personal (per-user) "Later" flag — pin a thread to your Later list to come
 * back to it. Body: { later: boolean }. Staff-only.
 *
 * ⚠️ PARKING A THREAD USED TO MARK IT READ. The flag lived on
 * internal_thread_reads, whose `last_read_at` is NOT NULL DEFAULT now() — so the
 * INSERT that recorded "park this" also stamped "I have read everything in it".
 * Park something you have never opened and its unread count silently went to
 * zero, which is the exact opposite of what Later means.
 *
 * Writing `last_read_at: epoch` in the same upsert would NOT fix it: an upsert
 * updates the columns you send, so on an EXISTING row it would drag a real,
 * advanced read pointer back to 1970 and resurface everything already read.
 *
 * And a read row is also PARTICIPATION — the client-conversation push targets
 * whoever holds one — so seeding a row on park would additionally subscribe you
 * to that conversation's phone alerts with no way off.
 *
 * So the flag gets its own sparse table: presence = parked. This mirrors
 * `internal_root_later` (20260718-1700), created for this identical reason one
 * grain down; the thread grain never got the same treatment until now.
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
  const later = body.later !== false // default true unless explicitly false

  // Presence = parked. Never touches the read pointer, so parking an unopened
  // thread leaves every unread message unread.
  const { error } = later
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? await (supabaseAdmin as any)
        .from('internal_thread_later')
        .upsert({ thread_id: threadId, user_id: user.id }, { onConflict: 'thread_id,user_id', ignoreDuplicates: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : await (supabaseAdmin as any)
        .from('internal_thread_later')
        .delete()
        .eq('thread_id', threadId)
        .eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, later })
}
