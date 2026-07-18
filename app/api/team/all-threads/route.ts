import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/team/all-threads
 * Every thread across every channel for the Board — one row per thread with the
 * channel it belongs to, its stage, reply count, last activity, whether it's new
 * for the caller (bold + dot), and whether they follow it. Bounded server-side
 * (newest activity first + a cap) so it can't become an unbounded scan. Staff-only.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  // Archived threads are excluded by default; `?include_archived=1` is how the
  // board surfaces them for a restore.
  const includeArchived = request.nextUrl.searchParams.get('include_archived') === '1'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .rpc('list_all_threads', { p_user_id: user.id, p_limit: 300, p_include_archived: includeArchived })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ threads: data ?? [] })
}
