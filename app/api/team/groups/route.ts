import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { createGroup } from '@/lib/team/groups'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/groups — create a team group chat. Body: { name, member_ids } (the creator is added automatically).
 * Staff only. At least two other people; real team members only. See lib/team/groups-rules.ts.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const r = await createGroup(user.id, body.name, body.member_ids)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json(r.value)
}
