import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { resolveDismissedAt } from '@/lib/team/chat-window-threads'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/dismiss-mention
 * Personal (per-user) "mark done" for a client conversation's mentions —
 * clears it from the caller's own floating-chat CLIENTS list. Reappears if a
 * NEW mention lands after this timestamp (see app/api/team/threads/route.ts's
 * everMentionedSet, which compares each mention's created_at against this
 * row). Staff-only. Own sparse table — see the migration file for why this
 * must not touch internal_thread_reads or internal_thread_later.
 *
 * Body: { asOf?: string } — the client's own clock reading at the moment of
 * the click, not when this request happens to be processed (bug-hunter,
 * 2026-09-05). Server request-handling latency sits inside the window a
 * fresh mention could land in; anchoring to the click instead of "now" here
 * removes that slice of the race (a genuinely simultaneous human collision on
 * the same thread is still possible and self-heals on the next mention —
 * documented, not engineered around). Rejected if missing, malformed, or in
 * the future — falls back to server "now" rather than trusting a bad value.
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
  const dismissedAt = resolveDismissedAt(body?.asOf, Date.now())

  // Upsert, not insert-if-absent: re-dismissing after a fresh mention must
  // advance the stamp so THAT mention is covered too, not just the first one.
  const { error } = await (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    .from('internal_thread_mention_dismissals')
    .upsert(
      { thread_id: threadId, user_id: user.id, dismissed_at: dismissedAt },
      { onConflict: 'thread_id,user_id' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
