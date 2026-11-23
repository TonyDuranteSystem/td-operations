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
import { listTeamManagers } from './may-manage'
import { buildSharingList, type ShareRow, type SharingLine } from './sharing-list'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = () => supabaseAdmin as any

const FULL_COLUMNS =
  'id, auth_user_id, username, display_name, capabilities, status, created_at, switched_off_by, switched_off_at, switched_off_reason, notice_version, notice_accepted_at, notice_accepted_ip'
const OLD_COLUMNS = 'id, auth_user_id, username, display_name, capabilities, status, created_at'

export interface SharingData {
  /** False when the sharing list could not be read — the card then says so; it never draws that as "nobody shares". */
  available: boolean
  lines: SharingLine[]
}

export interface TeamCardData {
  /** False while the database does not have the step 2 columns / record table yet (read-only list, no switch). */
  ready: boolean
  /** False when the record (history) could not be READ right now although the database has it: the card says so, the switch buttons stay. */
  historyAvailable: boolean
  members: CardMember[]
  /** Who shares their personal documents with which login, and whether the login can see them now (staff only). */
  sharing: SharingData
}

/**
 * The current "owner shares personal documents with team login" list of ONE company, with whether each login can see them now.
 * Never throws: a list that cannot be read comes back `available: false` so the card says so instead of showing an empty list.
 */
export async function loadSharing(accountId: string, members: CardMemberRow[]): Promise<SharingData> {
  try {
    const { data, error } = await sb().from('portal_team_document_shares').select('team_member_id, owner_contact_id, created_at').eq('account_id', accountId)
    if (error) throw new Error(error.message)
    const shares = (data ?? []) as ShareRow[]
    if (shares.length === 0) return { available: true, lines: [] }

    const ownerIds = Array.from(new Set(shares.map((s) => s.owner_contact_id)))
    const ownerNames: Record<string, string> = {}
    const names = await sb().from('contacts').select('id, full_name').in('id', ownerIds)
    if (names.error) throw new Error(names.error.message)
    for (const c of (names.data ?? []) as Array<{ id: string; full_name: string | null }>) if (c.full_name) ownerNames[c.id] = c.full_name

    // The same "current owner or member of this company" test the viewing rule uses. It THROWS when the owners cannot be read, so a failed
    // read makes the whole list "could not read" — never a wrong "cannot see" for every owner.
    const currentOwners = new Set((await listTeamManagers(accountId)).map((m) => m.contactId))

    return { available: true, lines: buildSharingList({ shares, members, ownerNames, currentOwners }) }
  } catch (err) {
    // eslint-disable-next-line no-console -- a failed read must be visible in the server log; the card says "could not read"
    console.error('[team-card] could not read the sharing list', err instanceof Error ? err.message : err)
    return { available: false, lines: [] }
  }
}

/** The database does not have a column / table yet (code deployed before its database change) — as opposed to a read that merely failed. */
function isMissingSchema(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  return err.code === '42703' || err.code === '42P01' || err.code === 'PGRST204' || err.code === 'PGRST205' || /does not exist|schema cache/i.test(err.message ?? '')
}

export async function loadTeamCard(accountId: string): Promise<TeamCardData> {
  let ready = true
  let historyAvailable = true
  let res = await sb().from('portal_team_members').select(FULL_COLUMNS).eq('account_id', accountId).order('created_at', { ascending: true })
  if (res.error) {
    // Only a MISSING column means "the database change is not on this system yet" (read-only list, no switch). Any other failure is a read
    // that failed: it must not switch the buttons off and tell staff the system is not ready (dev job e59dd470, 20 Nov hunt D#3b).
    if (!isMissingSchema(res.error)) throw new Error('Could not read the team logins.')
    ready = false
    res = await sb().from('portal_team_members').select(OLD_COLUMNS).eq('account_id', accountId).order('created_at', { ascending: true })
  }
  // Both reads failed: that is "could not read", never "no team logins" (the card would simply vanish).
  if (res.error) throw new Error('Could not read the team logins.')
  const members = (res.data ?? []) as CardMemberRow[]
  if (members.length === 0) return { ready, historyAvailable, members: [], sharing: { available: true, lines: [] } }

  let events: CardEventRow[] = []
  if (ready) {
    const ev = await sb()
      .from('portal_team_events')
      .select('team_member_id, event, actor_kind, actor_contact_id, actor_staff_email, detail, ip, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(500)
    if (ev.error) {
      if (isMissingSchema(ev.error)) ready = false // the record table is not on this system yet
      else {
        historyAvailable = false // the table is there but could not be read now: the people and the switch buttons stay, the card says so
        // eslint-disable-next-line no-console -- a failed read must be visible in the server log; the card says "history could not be read"
        console.error('[team-card] could not read the team record', ev.error.message)
      }
    } else events = (ev.data ?? []) as CardEventRow[]
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
  const signInUnreadable: string[] = []
  await Promise.all(
    members.map(async (m) => {
      if (!m.auth_user_id) return
      try {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(m.auth_user_id)
        if (error) {
          signInUnreadable.push(m.auth_user_id) // a failed lookup is NOT "never signed in"
          return
        }
        signIns[m.auth_user_id] = data?.user?.last_sign_in_at ?? null
      } catch {
        signInUnreadable.push(m.auth_user_id)
      }
    }),
  )

  const sharing = await loadSharing(accountId, members)
  return { ready, historyAvailable, members: buildTeamCard({ members, events, names, signIns, signInUnreadable }), sharing }
}
