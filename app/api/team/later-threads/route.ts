import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/team/later-threads
 * The caller's "bring forward" list — threads flagged from any channel, newest
 * flag first, each carrying the channel it lives in.
 *
 * Its own endpoint rather than a flag folded into the board: this is a personal,
 * short, cross-channel list rendered in the sidebar, and reusing the board query
 * would mean pulling 300 rows to show a handful. Archived threads are excluded
 * server-side — an archived thread is not "coming back". Staff-only.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .rpc('list_later_threads', { p_user_id: user.id })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[]
  // Read-receipt / "whose turn" state — the shared calculation used everywhere.
  const { enrichThreadTurn } = await import('@/lib/team/thread-turn-server')
  const turnMap = await enrichThreadTurn(rows.map(r => r.root_message_id), user.id)
  const threads = rows.map(r => {
    const turn = turnMap[r.root_message_id]
    return { ...r, read_state: turn?.read_state ?? 'none', waiting_name: turn?.waiting_name ?? null }
  })
  return NextResponse.json({ threads })
}
