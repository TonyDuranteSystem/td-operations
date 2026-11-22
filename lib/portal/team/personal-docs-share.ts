/**
 * Team Powers step 7 — an OWNER shares (or stops sharing) THEIR OWN personal documents with one team login.
 *
 * The share is a row in `portal_team_document_shares` (team login + the owner's contact id). It belongs to the OWNER who made it:
 * an owner can only switch on or off their own papers, never a co-owner's. A team login with no row sees no personal document at all.
 *
 * Rules (each has a test):
 *   - Switching ON needs the login to be active and to have the Documents tick (without it the login cannot open the Documents page).
 *   - Switching ON needs the owner's confirmation — the notice accepted word for word and their password — checked by the route
 *     (confirm-request.ts) and passed in here; without it nothing is saved.
 *   - No record, no grant: the line of the team record is written strictly; if it cannot be saved the share is undone.
 *   - Switching OFF is never blocked: it works for a switched-off login too, and a failing record line never stops it.
 *   - Doing the same thing twice changes nothing (no second line in the record).
 *   - A database read or write that fails is an ERROR the owner sees, never "nothing changed": a failed read must not look like "no share to stop".
 *   - A share lives only while the login stays continuously active: switching the login off or removing it ends its shares
 *     (personal-docs-server.ts `endSharesOfLogin`, called from switch.ts and server.ts) — the owner shares again after a switch back on.
 *
 * Dependencies are passed in so the rules run without a database (tests); personal-docs-server.ts wires the real ones.
 */
import { normalizeCapabilities, hasCapability } from './capabilities'
import type { Confirmation } from './confirm'
import type { TeamEventInput } from './events'

export interface ShareMemberRow {
  id: string
  display_name: string
  status: string
  capabilities: unknown
}

export interface ShareDeps {
  /** Throws when the database cannot be read (a read error is never the same as "no such person"). */
  fetchMember: (teamMemberId: string, accountId: string) => Promise<ShareMemberRow | null>
  /** Throws when the database cannot be read (a read error is never the same as "no share"). */
  hasShare: (teamMemberId: string, ownerContactId: string) => Promise<boolean>
  addShare: (row: { team_member_id: string; owner_contact_id: string; account_id: string; notice_version: string | null; granted_ip: string | null }) => Promise<void>
  removeShare: (teamMemberId: string, ownerContactId: string) => Promise<void>
  /** STRICT: throws when the line cannot be saved. */
  recordEvent: (input: TeamEventInput) => Promise<void>
  /** Never throws. */
  recordEventBestEffort: (input: TeamEventInput) => Promise<boolean>
}

export interface ShareInput {
  teamMemberId: string
  accountId: string
  /** The owner who is acting — taken from the signed-in person on the server, never from the request. */
  ownerContactId: string
  enabled: boolean
  /** The accepted notice (version, exact words, address). Required to switch ON. */
  confirmation?: Confirmation | null
  ip: string | null
}

export type ShareResult = { ok: true; changed: boolean } | { ok: false; status: number; error: string; needsConfirmation?: boolean }

/** A database read or write failed. Said out loud: "nothing changed" would be a lie when the share may still be there. */
const COULD_NOT_CHECK = 'We could not check your sharing right now, so nothing was changed. Please try again.'
const COULD_NOT_STOP = 'We could not stop the sharing right now. Please try again — until it says it stopped, the person may still see your documents.'

export async function setPersonalDocShare(input: ShareInput, deps: ShareDeps): Promise<ShareResult> {
  let member: ShareMemberRow | null
  let already: boolean
  try {
    member = await deps.fetchMember(input.teamMemberId, input.accountId)
    if (!member) return { ok: false, status: 404, error: 'Team member not found.' }
    already = await deps.hasShare(input.teamMemberId, input.ownerContactId)
  } catch {
    return { ok: false, status: 500, error: COULD_NOT_CHECK }
  }

  const actor = { kind: 'owner' as const, contactId: input.ownerContactId, ip: input.ip }

  if (!input.enabled) {
    if (!already) return { ok: true, changed: false }
    try {
      await deps.removeShare(input.teamMemberId, input.ownerContactId)
    } catch {
      return { ok: false, status: 500, error: COULD_NOT_STOP }
    }
    await deps.recordEventBestEffort({
      teamMemberId: input.teamMemberId,
      accountId: input.accountId,
      event: 'powers_changed',
      actor,
      detail: { personal_documents: false, owner_contact_id: input.ownerContactId },
    })
    return { ok: true, changed: true }
  }

  if (member.status !== 'active') return { ok: false, status: 400, error: 'This person is switched off. Switch them on first.' }
  if (!hasCapability(normalizeCapabilities(member.capabilities), 'documents')) {
    return { ok: false, status: 400, error: 'Give this person the Documents tick first: without it they cannot open the Documents page.' }
  }
  if (already) return { ok: true, changed: false }
  if (!input.confirmation) {
    return { ok: false, status: 409, error: 'Read the notice and confirm with your password to share your personal documents.', needsConfirmation: true }
  }

  await deps.addShare({
    team_member_id: input.teamMemberId,
    owner_contact_id: input.ownerContactId,
    account_id: input.accountId,
    notice_version: input.confirmation.version,
    granted_ip: input.confirmation.ip ?? input.ip,
  })
  try {
    await deps.recordEvent({
      teamMemberId: input.teamMemberId,
      accountId: input.accountId,
      event: 'powers_changed',
      actor,
      detail: {
        personal_documents: true,
        owner_contact_id: input.ownerContactId,
        // Their own names (NOT notice_version / notice_text): the staff Team card shows "the notice accepted" from the newest line that
        // carries those two, and these words are a different notice — they must never replace the one accepted when the person was added.
        personal_docs_notice_version: input.confirmation.version,
        personal_docs_notice_text: input.confirmation.text,
      },
    })
  } catch {
    await deps.removeShare(input.teamMemberId, input.ownerContactId).catch(() => undefined)
    return { ok: false, status: 500, error: 'We could not save the record of this change, so nothing was shared. Please try again.' }
  }
  return { ok: true, changed: true }
}
