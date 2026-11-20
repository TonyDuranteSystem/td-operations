/**
 * Team Powers step 7 — database wiring for "an owner shares their own personal documents with a team login"
 * (the rules live in personal-docs-share.ts, the viewing rule in lib/documents/visibility-guard.ts). Server only.
 *
 * Table `portal_team_document_shares`: one row per (team login, owner contact). Read ONLY through this file.
 */
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability } from '@/lib/portal/team/capabilities'
import { mayManageTeam } from '@/lib/portal/team/may-manage'
import { recordTeamEvent, recordTeamEventBestEffort } from '@/lib/portal/team/events'
import type { ShareDeps, ShareMemberRow } from '@/lib/portal/team/personal-docs-share'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = () => supabaseAdmin as any

export function shareDeps(): ShareDeps {
  return {
    fetchMember: async (teamMemberId, accountId) => {
      const { data } = await sb().from('portal_team_members').select('id, display_name, status, capabilities').eq('id', teamMemberId).eq('account_id', accountId).maybeSingle()
      return (data as ShareMemberRow | null) ?? null
    },
    hasShare: async (teamMemberId, ownerContactId) => {
      const { data } = await sb().from('portal_team_document_shares').select('team_member_id').eq('team_member_id', teamMemberId).eq('owner_contact_id', ownerContactId).maybeSingle()
      return !!data
    },
    addShare: async (row) => {
      const { error } = await sb().from('portal_team_document_shares').insert(row)
      if (error && !/duplicate key/i.test(error.message)) throw new Error(error.message)
    },
    removeShare: async (teamMemberId, ownerContactId) => {
      const { error } = await sb().from('portal_team_document_shares').delete().eq('team_member_id', teamMemberId).eq('owner_contact_id', ownerContactId)
      if (error) throw new Error(error.message)
    },
    recordEvent: (input) => recordTeamEvent(sb(), input),
    recordEventBestEffort: (input) => recordTeamEventBestEffort(sb(), input),
  }
}

/** Which team logins of this company has THIS owner shared their personal documents with (for the Team screen). */
export async function getMySharedMemberIds(accountId: string, ownerContactId: string): Promise<Set<string>> {
  const { data } = await sb().from('portal_team_document_shares').select('team_member_id').eq('account_id', accountId).eq('owner_contact_id', ownerContactId)
  return new Set(((data ?? []) as { team_member_id: string }[]).map((r) => r.team_member_id))
}

export interface SharedOwner {
  contactId: string
  name: string
  /** The company the team login belongs to (it is scoped to exactly one). */
  accountId: string
}

export interface SharedOwnersDeps {
  resolveIdentity: typeof resolvePortalIdentity
  fetchShares: (teamMemberId: string) => Promise<string[]>
  /** True when the owner is still a current owner/member of the company (a removed owner's share stops). */
  stillOwner: (contactId: string, accountId: string) => Promise<boolean>
  names: (contactIds: string[]) => Promise<Map<string, string>>
}

const defaultSharedOwnersDeps: SharedOwnersDeps = {
  resolveIdentity: resolvePortalIdentity,
  fetchShares: async (teamMemberId) => {
    const { data } = await sb().from('portal_team_document_shares').select('owner_contact_id').eq('team_member_id', teamMemberId)
    return ((data ?? []) as { owner_contact_id: string }[]).map((r) => r.owner_contact_id)
  },
  stillOwner: (contactId, accountId) => mayManageTeam(contactId, accountId),
  names: async (contactIds) => {
    if (contactIds.length === 0) return new Map()
    const { data } = await sb().from('contacts').select('id, full_name').in('id', contactIds)
    return new Map(((data ?? []) as { id: string; full_name: string | null }[]).map((c) => [c.id, c.full_name ?? '']))
  },
}

/**
 * The owners whose personal documents THIS signed-in person may see because the owner shared them. Empty for everyone but an active team
 * login that holds the Documents tick (a login still waiting for its notice has its powers held back, so it gets none). A share whose owner is no
 * longer an owner or member of the company is ignored. Never throws: any failure means "no one shared anything".
 */
export async function getSharedPersonalDocOwners(user: User | null, deps: SharedOwnersDeps = defaultSharedOwnersDeps): Promise<SharedOwner[]> {
  try {
    if (!user) return []
    const identity = await deps.resolveIdentity(user)
    if (identity.kind !== 'teammate') return []
    if (!hasCapability(identity.capabilities, 'documents')) return []
    const ids = await deps.fetchShares(identity.teamMemberId)
    if (ids.length === 0) return []
    const current: string[] = []
    for (const id of ids) if (await deps.stillOwner(id, identity.accountId)) current.push(id)
    if (current.length === 0) return []
    const names = await deps.names(current)
    return current.map((contactId) => ({ contactId, name: names.get(contactId) || '', accountId: identity.accountId }))
  } catch (err) {
    // eslint-disable-next-line no-console -- a failed lookup must be visible in the server log; the safe answer is "nothing shared"
    console.error('[personal-docs] could not read the shares', err instanceof Error ? err.message : err)
    return []
  }
}

export interface PersonalDocRow {
  id: string
  file_name: string
  document_type_name: string | null
  category: number | null
  drive_file_id: string | null
  processed_at: string | null
  created_at: string
  service_delivery_id: string | null
}

/**
 * The personal documents the portal lists for ONE person — the same three places "My Documents" reads (app/portal/documents/page.tsx):
 * their papers filed under the selected company, their person-level papers (no company), and their own papers in the new storage.
 * Only visible rows (portal_visible), never a flow document (those are grouped separately), newest first.
 */
export async function listPersonalDocsOfContact(contactId: string, accountId: string): Promise<PersonalDocRow[]> {
  const cols = 'id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, service_delivery_id'
  const [a, b, c] = await Promise.all([
    sb().from('documents').select(cols).eq('account_id', accountId).eq('contact_id', contactId).eq('category', 2).eq('portal_visible', true).is('service_delivery_id', null).order('created_at', { ascending: false }).limit(50),
    sb().from('documents').select(cols).is('account_id', null).eq('contact_id', contactId).eq('category', 2).is('service_delivery_id', null).eq('portal_visible', true).order('created_at', { ascending: false }).limit(50),
    sb().from('documents').select(cols).eq('contact_id', contactId).eq('category', 2).eq('portal_visible', true).like('drive_file_id', 'store:%').is('service_delivery_id', null).order('created_at', { ascending: false }).limit(50),
  ])
  const seen = new Set<string>()
  return [...(a.data ?? []), ...(b.data ?? []), ...(c.data ?? [])].filter((d: PersonalDocRow) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
}
