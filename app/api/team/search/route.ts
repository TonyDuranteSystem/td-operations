import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/team/search?q=...  — search team messages the caller can see
 * (DM visibility enforced in the RPC). Staff-only. Returns up to 50 matches.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) {
    return NextResponse.json({ results: [] })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any).rpc('search_team_messages', {
    p_user_id: user.id,
    p_query: q,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ results: data ?? [] })
}
