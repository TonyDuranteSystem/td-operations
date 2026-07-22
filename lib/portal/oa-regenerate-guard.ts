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
