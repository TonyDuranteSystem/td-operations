import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { dmKey } from '@/lib/team/workspace'
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

  const key = dmKey(user.id, otherId)

  // Reuse an existing DM thread if present.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('*')
    .eq('dm_key', key)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ thread: existing, reused: true })
  }

  const now = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread, error } = await (supabaseAdmin as any)
    .from('internal_threads')
    .insert({
      thread_type: 'dm',
      dm_key: key,
      title: `DM: ${key}`,
      created_by: user.id,
      last_activity_at: now,
    })
    .select()
    .single()

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      // Race — someone created it between our check and insert. Fetch and return.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: raced } = await (supabaseAdmin as any)
        .from('internal_threads').select('*').eq('dm_key', key).maybeSingle()
      if (raced) return NextResponse.json({ thread: raced, reused: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ thread })
}
