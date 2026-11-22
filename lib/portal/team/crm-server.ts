/**
 * Team Powers step 5 — loads one company's team for the CRM card (database + auth-admin backed, STAFF ONLY).
 *
 * Reads only. The switch off / on itself reuses `switchTeammateOff` / `switchTeammateOn` from server.ts, with a TD actor.
 * Nothing here ever touches the company's members list or any contact.
 *
 * Before the step 2 database change is on a database, the switch-off and notice columns and the record table do not exist:
 * the card then lists the people the old way (no switch, no record) instead of failing, and says so (`ready: false`).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildTeamCard, type CardEventRow, type CardMember, type CardMemberRow } from './crm-view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = () => supabaseAdmin as any

const FULL_COLUMNS =
  'id, auth_user_id, username, display_name, capabilities, status, created_at, switched_off_by, switched_off_at, switched_off_reason, notice_version, notice_accepted_at, notice_accepted_ip'
const OLD_COLUMNS = 'id, auth_user_id, username, display_name, capabilities, status, created_at'

export interface TeamCardData {
  /** False while the database does not have the step 2 columns / record table yet (read-only list, no switch). */
  ready: boolean
  members: CardMember[]
}

export async function loadTeamCard(accountId: string): Promise<TeamCardData> {
  let ready = true
  let res = await sb().from('portal_team_members').select(FULL_COLUMNS).eq('account_id', accountId).order('created_at', { ascending: true })
  if (res.error) {
    ready = false
    res = await sb().from('portal_team_members').select(OLD_COLUMNS).eq('account_id', accountId).order('created_at', { ascending: true })
  }
  // Both reads failed: that is "could not read", never "no team logins" (the card would simply vanish).
  if (res.error) throw new Error('Could not read the team logins.')
  const members = (res.data ?? []) as CardMemberRow[]
  if (members.length === 0) return { ready, members: [] }

  let events: CardEventRow[] = []
  if (ready) {
    const ev = await sb()
      .from('portal_team_events')
      .select('team_member_id, event, actor_kind, actor_contact_id, actor_staff_email, detail, ip, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(500)
    if (ev.error) ready = false
    else events = (ev.data ?? []) as CardEventRow[]
  }

  // Names of the owners named in the record.
  const contactIds = Array.from(new Set(events.map((e) => e.actor_contact_id).filter((x): x is string => !!x)))
  const names: Record<string, string> = {}
  if (contactIds.length > 0) {
    const { data } = await sb().from('contacts').select('id, full_name').in('id', contactIds)
    for (const c of (data ?? []) as Array<{ id: string; full_name: string | null }>) if (c.full_name) names[c.id] = c.full_name
  }

  // Last sign-in of each login (one lookup per person; a company's team is a handful of people).
  const signIns: Record<string, string | null> = {}
  await Promise.all(
    members.map(async (m) => {
      if (!m.auth_user_id) return
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(m.auth_user_id)
        signIns[m.auth_user_id] = data?.user?.last_sign_in_at ?? null
      } catch {
        signIns[m.auth_user_id] = null
      }
    }),
  )

  return { ready, members: buildTeamCard({ members, events, names, signIns }) }
}
