/**
 * Team Powers — the STAFF "who shares their personal documents with whom" list (dev job e59dd470, bug hunt). Pure, read-only, no database.
 *
 * An owner can let ONE team login see their own personal papers (passport, ID). Only the owner's own Team page showed that; staff saw
 * history lines only. This builds the CURRENT list for the staff Team card, one line per share, and says whether the login can really
 * see the papers right now — using the same conditions as the viewing rule (`getSharedPersonalDocOwners` in personal-docs-server.ts):
 * the login is active, is not still waiting for its own notice (its powers are held back until it accepts), holds the Documents tick,
 * and the owner is still an owner / member of the company. A share that exists but fails one of those is listed WITH the reason, so staff
 * never read "shared" as "visible".
 */
import { hasCapability, normalizeCapabilities } from './capabilities'
import { cardState, type CardMemberRow } from './crm-view'

export type SharingStatus = 'can_see' | 'login_off' | 'waiting_notice' | 'no_documents_power' | 'owner_not_current'

export interface ShareRow {
  team_member_id: string
  owner_contact_id: string
  created_at: string | null
}

export interface SharingLine {
  ownerContactId: string
  ownerName: string
  loginId: string
  loginName: string
  loginUsername: string
  /** When the owner shared (ISO), or null. */
  since: string | null
  status: SharingStatus
}

export const SHARING_STATUS_TEXT: Record<SharingStatus, string> = {
  can_see: 'Allowed to see them now (only documents published to the portal)',
  login_off: 'Cannot see them — this login is switched off or removed',
  waiting_notice: 'Cannot see them yet — this login has not accepted its own notice',
  no_documents_power: 'Cannot see them — this login does not have the Documents power',
  owner_not_current: 'Cannot see them — the owner no longer has current access as an owner or member of this company',
}

const ORDER: Record<SharingStatus, number> = { can_see: 0, waiting_notice: 1, no_documents_power: 2, owner_not_current: 3, login_off: 4 }

/** The first reason (in the viewing rule's order) why this login cannot see the owner's papers, or 'can_see'. */
export function sharingStatus(
  member: Pick<CardMemberRow, 'status' | 'switched_off_at' | 'switched_off_by' | 'capabilities' | 'notice_version'> | null,
  ownerIsCurrent: boolean,
): SharingStatus {
  if (!member) return 'login_off'
  if (cardState(member) !== 'active') return 'login_off'
  // The same test the sign-in uses: a login whose notice version is null has not accepted its own notice, so its powers are held back.
  if (member.notice_version === null) return 'waiting_notice'
  if (!hasCapability(normalizeCapabilities(member.capabilities), 'documents')) return 'no_documents_power'
  if (!ownerIsCurrent) return 'owner_not_current'
  return 'can_see'
}

export function buildSharingList(input: {
  shares: ShareRow[]
  members: CardMemberRow[]
  /** contact id → full name */
  ownerNames: Record<string, string>
  /** contact ids that are STILL an owner / member of this company */
  currentOwners: ReadonlySet<string>
}): SharingLine[] {
  const byId = new Map(input.members.map((m) => [m.id, m]))
  const lines = input.shares.map((s): SharingLine => {
    const m = byId.get(s.team_member_id) ?? null
    return {
      ownerContactId: s.owner_contact_id,
      ownerName: input.ownerNames[s.owner_contact_id] || 'An owner',
      loginId: s.team_member_id,
      loginName: m ? (m.display_name ?? '').trim() || m.username || 'Unnamed' : 'A login that no longer exists',
      loginUsername: m?.username ?? '',
      since: s.created_at,
      status: sharingStatus(m, input.currentOwners.has(s.owner_contact_id)),
    }
  })
  return lines.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.since ?? '').localeCompare(a.since ?? ''))
}

export type SharingBlockMode = 'unavailable' | 'empty' | 'list'

/** What the sharing block of the card draws. A list that could not be read is a notice, never the same as "nobody shares". */
export function sharingBlockMode(input: { available: boolean; lineCount: number }): SharingBlockMode {
  if (!input.available) return 'unavailable'
  return input.lineCount === 0 ? 'empty' : 'list'
}
