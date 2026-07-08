import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin, getUserDisplayName } from '@/lib/auth'
import { listTeamMembers } from '@/lib/team/directory'
import { NextResponse } from 'next/server'

/**
 * GET /api/team/threads
 * Team Workspace sidebar payload: every channel / DM / discussion / general room
 * the current user can see, with PER-USER unread counts (via get_team_threads),
 * plus the staff directory (for DMs + @mention autocomplete) and the caller's
 * identity. Staff-only.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: threads, error } = await (supabaseAdmin as any)
    .rpc('get_team_threads', { p_user_id: user.id })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Enrich client-discussion threads with the account/contact display name so
  // the sidebar can label them without a second round-trip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched = await Promise.all((threads ?? []).map(async (t: any) => {
    let label: string | null = t.channel_name ?? t.title ?? null
    if (t.thread_type === 'discussion') {
      if (t.account_id) {
        const { data: a } = await supabaseAdmin.from('accounts').select('company_name').eq('id', t.account_id).single()
        label = a?.company_name ?? label
      } else if (t.contact_id) {
        const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', t.contact_id).single()
        label = c?.full_name ?? label
      }
    }
    return { ...t, label: label ?? 'Discussion' }
  }))

  const members = await listTeamMembers()

  return NextResponse.json({
    threads: enriched,
    members,
    current_user_id: user.id,
    current_user_name: getUserDisplayName(user),
    is_admin: isAdmin(user),
  })
}
