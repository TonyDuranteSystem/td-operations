import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { staffInitials, tidyStaffName, type WaitingStaff } from '@/lib/portal-chats/waiting-owner'

/**
 * GET /api/portal/chat/waiting-staff — Admin/staff only.
 * The team members a "Waiting on us" conversation can belong to: the same staff list Team Chat uses (admin and team logins that are not
 * blocked; clients, partners and marketing logins are never on it). Names are tidied for display ("antonio.durante" → "Antonio Durante").
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }
  try {
    const { listTeamMembers } = await import('@/lib/team/directory')
    const staff: WaitingStaff[] = (await listTeamMembers())
      .map(m => ({ id: m.id, name: tidyStaffName(m.name), initials: staffInitials(m.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json(staff, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Could not read the team list. Please try again.' }, { status: 500 })
  }
}
