import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { findOrCreateDm } from '@/lib/team/dm'
import { listTeamMembers } from '@/lib/team/directory'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/dms
 * Find-or-create a direct-message thread between the current user and another
 * staff member. Body: { user_id }.  Deduped by dm_key (partial-unique index).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const otherId: string = (body.user_id ?? '').trim()
  if (!otherId) {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  // The other party must be a real staff member (not a client, not a stranger).
  const members = await listTeamMembers()
  const other = members.find(m => m.id === otherId)
  if (!other) {
    return NextResponse.json({ error: 'That teammate was not found.' }, { status: 404 })
  }

  try {
    const { thread, reused } = await findOrCreateDm(user.id, otherId)
    return NextResponse.json(reused ? { thread, reused: true } : { thread })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to open DM' },
      { status: 500 },
    )
  }
}
