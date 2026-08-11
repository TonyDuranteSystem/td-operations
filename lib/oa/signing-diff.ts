/**
 * Did a member edit MATERIALLY change the Operating Agreement's roster or signing
 * set? Pure, unit-tested, no I/O — the die-on-change decision (lib/operations/
 * oa-refresh.ts) rests entirely on this so it can be pinned by fixtures.
 *
 * ⛔ WHY THIS IS DELICATE. Getting it wrong in EITHER direction is a real harm:
 *   - too eager → a phone-number fix or a re-submitted-same-roster voids a live
 *     agreement and emails the client "regenerate your OA" for nothing, and does
 *     it across the 74 production SMLLC drafts if shape is mishandled.
 *   - too lax → a removed/replaced owner, or an SMLLC that grew a second member,
 *     leaves a stale agreement that the wrong person can still sign.
 *
 * THE RULES:
 *   1. Identity-keyed, ORDER-INSENSITIVE. The member-info form REPLACES the whole
 *      roster with fresh row ids and recomputes is_primary from the form's array
 *      order (Full Throttle proved same-millisecond ties) — so row id, order and
 *      is_primary are NEVER compared. A person is keyed by contact_id, else
 *      normalized email, else normalized name.
 *   2. SHAPE-AWARE, BOTH DIRECTIONS. An SMLLC agreement whose company now has 2+
 *      members has converted → material (the stale single-member OA must die). An
 *      MMLLC agreement whose roster collapsed is material too. A steady-state
 *      SMLLC (still one member, or an is_primary/phone edit) is NEVER material —
 *      that is the "single-member untouched" boundary.
 *   3. NORMALIZED EXACTLY like the writers. Signer display names go through the
 *      same signerDisplayName() the create route used to write oa_signatures, and
 *      ownership is compared as `pct ?? 0` rounded — so "null vs 0" and the
 *      "(for Company)" suffix never read as a change when nothing changed.
 *   4. BOTH the roster (every member + ownership, because the document must
 *      contain all members) AND the signer set (who can sign) are compared. A
 *      change to either is material — an email-less member added to the roster
 *      changes no signer but still belongs on the legal document.
 */

import { normalizeEntityType } from '@/lib/portal/entity-type'
import { resolveSigningSet, signerDisplayName, type SigningSetMemberRow } from '@/lib/members/signing-set'

/** A live member row as read from the members table (superset of SigningSetMemberRow). */
export interface DiffMemberRow extends SigningSetMemberRow {
  ownership_pct?: number | null
}

/** A member entry as pinned in oa_agreements.members JSONB. */
export interface PinnedMember {
  name?: string | null
  email?: string | null
  ownership_pct?: number | null
}

/** A pinned oa_signatures row (only the identity fields matter here). */
export interface PinnedSignerRow {
  member_name?: string | null
  member_email?: string | null
  contact_id?: string | null
}

export interface SigningDiffInput {
  /** oa_agreements.entity_type (long OR short form — normalized inside). */
  agreementEntityType: string | null
  /** oa_agreements.members JSONB (null for an SMLLC agreement). */
  pinnedMembers: PinnedMember[] | null
  /** The oa_signatures rows pinned to the agreement. */
  pinnedSignerRows: PinnedSignerRow[]
  /** The company's CURRENT members table rows. */
  liveMemberRows: DiffMemberRow[]
}

export interface SigningDiff {
  material: boolean
  /** Plain-English reasons, for the audit/log. Empty when not material. */
  reasons: string[]
}

const norm = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim().toLowerCase()
  return s === '' ? null : s
}

/** Round ownership to 2 decimals; null/absent counts as 0. */
const pct = (v: number | null | undefined): number => Math.round((Number(v) || 0) * 100) / 100

/** Identity of a ROSTER member: email first, then name. Never the row id/order. */
const rosterKey = (name: string | null | undefined, email: string | null | undefined): string =>
  norm(email) ?? norm(name) ?? '∅'

/** Identity of a SIGNER: linked contact first, then email, then name. */
const signerKey = (contactId: string | null | undefined, email: string | null | undefined, name: string | null | undefined): string =>
  (contactId && contactId.trim()) || norm(email) || norm(name) || '∅'

/** Stable multiset signature: sort the rendered tuples so order never matters. */
const multiset = (items: string[]): string => items.slice().sort().join('␟')

/**
 * Compare the live members table against what the agreement pinned. Returns
 * whether the change is material to the roster or the signing set.
 */
export function diffSigningState(input: SigningDiffInput): SigningDiff {
  const reasons: string[] = []
  const isMMLLCAgreement = normalizeEntityType(input.agreementEntityType) === 'MMLLC'
  const liveCount = input.liveMemberRows.length

  // ── SHAPE ─────────────────────────────────────────────────────────────────
  if (!isMMLLCAgreement) {
    // An SMLLC agreement is only touched when the company has genuinely become
    // multi-member (2+ member rows). One member, zero members, or an is_primary/
    // contact/phone edit on the sole member is NOT material — the single-member
    // boundary. (Ownership on a lone SMLLC member is meaningless to the SMLLC
    // template, which names one member at 100%.)
    if (liveCount >= 2) {
      return { material: true, reasons: [`SMLLC agreement but the company now has ${liveCount} members (converted to multi-member)`] }
    }
    return { material: false, reasons: [] }
  }

  // ── MMLLC: ROSTER (every member + ownership) ────────────────────────────────
  const liveRoster = multiset(
    input.liveMemberRows.map(m => {
      const name = m.full_name ?? m.company_name
      return `${rosterKey(name, m.email)}@${pct(m.ownership_pct)}`
    }),
  )
  const pinnedRoster = multiset(
    (input.pinnedMembers ?? []).map(m => `${rosterKey(m.name, m.email)}@${pct(m.ownership_pct)}`),
  )
  if (liveRoster !== pinnedRoster) {
    reasons.push('the member roster or an ownership percentage changed')
  }

  // ── MMLLC: SIGNING SET (who can sign + the name printed on the line) ─────────
  const liveSigners = multiset(
    resolveSigningSet(input.liveMemberRows).signers.map(s => `${signerKey(s.contactId, s.email, s.name)}|${norm(signerDisplayName(s)) ?? ''}`),
  )
  const pinnedSigners = multiset(
    input.pinnedSignerRows.map(r => `${signerKey(r.contact_id, r.member_email, r.member_name)}|${norm(r.member_name) ?? ''}`),
  )
  if (liveSigners !== pinnedSigners) {
    reasons.push('the set of people who must sign changed')
  }

  return { material: reasons.length > 0, reasons }
}
