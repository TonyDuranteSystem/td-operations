/**
 * Guard for the portal's self-service "Create & Send" Operating Agreement flow.
 *
 * Re-generating an OA hard-deletes the previous agreement AND every oa_signatures
 * row attached to it. That is only safe while NOTHING has been signed. The
 * original guard checked `status === 'signed'` alone, which is wrong for a
 * multi-member LLC: the OA stays 'partially_signed' until the LAST member signs,
 * so a re-generate at 2-of-3 signed destroyed two executed signatures with no
 * soft-delete and no audit row (R100). Found by the Council, 2026-07-22.
 *
 * Pure + dependency-free so the rule can be unit-tested without a DB.
 */
export interface ExistingOaForGuard {
  status: string | null
  signed_count?: number | null
}

/**
 * True when the existing OA carries at least one collected signature and must
 * therefore NOT be deleted by a re-generate.
 *
 * Deliberately checks THREE things rather than trusting any single field:
 * status can lag a signature write, and signed_count can be null on older rows.
 */
export function hasCollectedSignatures(existing: ExistingOaForGuard): boolean {
  if (existing.status === 'signed') return true
  if (existing.status === 'partially_signed') return true
  return (existing.signed_count ?? 0) > 0
}

/** Capital letters, runs of spaces and edge spaces do not make a different company name. */
export function oaNameKey(name: string | null | undefined): string {
  return (name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface NewestOaForNameChange {
  status: string | null
  company_name?: string | null
}

/**
 * Company Change Name, step 7: the company was RENAMED after its Operating Agreement was fully signed, so the client may
 * generate a NEW agreement that carries the new name. The signed one is never touched — no signature row and no agreement
 * row is deleted, voided or edited — it simply stops being the newest (the convention everywhere is "newest by created_at
 * is the current OA"). Derived from the data on the server (a fully signed newest agreement whose frozen name differs from
 * the account's name now); a request can never ask for it. A partly signed agreement is NOT covered: it keeps the refusal.
 */
export function isNameChangeNewVersion(newest: NewestOaForNameChange, accountName: string | null | undefined): boolean {
  if (newest.status !== 'signed') return false
  const frozen = oaNameKey(newest.company_name)
  const current = oaNameKey(accountName)
  return frozen !== '' && current !== '' && frozen !== current
}

/** The agreement token, made unique: `acme-oa-2026`, then `acme-oa-2026-2`, `-3` … when the plain one is taken (it is also the storage folder name). */
export function uniqueOaToken(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * The name a NEW agreement says the company was "formerly known as": the company name frozen into the most recent FULLY SIGNED agreement
 * when it differs from the company's name now (capitals/spacing do not count), else null. `existing` is newest first. Used both when the
 * agreement is saved and for the portal preview, so what the client previews is what is saved. Pure.
 */
export function previousNameForNewOa(existing: ReadonlyArray<NewestOaForNameChange>, accountName: string | null | undefined): string | null {
  const current = oaNameKey(accountName)
  if (current === '') return null
  for (const o of existing) {
    if (o.status !== 'signed') continue
    const frozen = (o.company_name ?? '').trim()
    if (frozen !== '' && oaNameKey(frozen) !== current) return frozen
  }
  return null
}


export interface OaForMembersMaySign {
  status: string | null
  signed_at?: string | null
  members_may_sign?: boolean | null
}

/**
 * Whether a NEW agreement keeps "each Member may also sign" (Section 2.3). The setting lives on the agreement row, and generating again
 * replaces the unsigned draft with a new row — so without this the new row started with the setting off and the owners' wording was lost
 * (Beril LLC, 2026-10-22). It follows the NEWEST agreement that is still a draft (never signed, not voided): that is the one being replaced,
 * and the portal preview reads the same rule so what the client previews is what is saved. A signed agreement never decides: its wording is
 * its own. `existing` is newest first. Pure.
 */
export function inheritMembersMaySign(existing: ReadonlyArray<OaForMembersMaySign>): boolean {
  for (const o of existing) {
    if (o.status === 'signed' || o.status === 'voided' || o.signed_at) continue
    return o.members_may_sign === true
  }
  return false
}
