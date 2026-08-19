/**
 * Normalize a stored entity_type string to the codes the portal wizard config
 * expects ('SMLLC' / 'MMLLC').
 *
 * Why this exists: the DB stores "Single Member LLC" / "Multi Member LLC"
 * (space, no hyphen) — verified 2026-05-20 (44 multi-member accounts, 2
 * formation offers, zero hyphenated). The wizard config only turns on the
 * "add members" step when it sees exactly 'MMLLC'. The old inline check
 * compared against "Multi-Member LLC" (hyphen), which exists nowhere in the
 * data, so the members step never rendered and multi-member clients could not
 * add co-owners (Adam Mihaly could not add Péter Nemeskéri).
 *
 * Matching is punctuation- and case-insensitive so every variant resolves:
 *   "Multi Member LLC", "Multi-Member LLC", "MMLLC"  → 'MMLLC'
 *   "Single Member LLC", "SMLLC"                     → 'SMLLC'
 * Non-LLC types (e.g. "C-Corp Elected") are returned unchanged so the wizard
 * config's Corp handling still applies.
 */
export function normalizeEntityType(raw: string | null | undefined): string {
  if (!raw) return 'SMLLC'
  const norm = raw.toLowerCase().replace(/[^a-z]/g, '')
  if (norm.includes('singlemember') || norm === 'smllc') return 'SMLLC'
  if (norm.includes('multimember') || norm === 'mmllc') return 'MMLLC'
  return raw
}

/**
 * Is this account a multi-owner company, for purposes of "does it need a
 * member roster / multiple signers / the MMLLC signer-blocking rule" — NOT
 * just "is entity_type literally an LLC with that text." A non-LLC shape
 * (e.g. a multi-member C-Corp election) still needs the same treatment, and
 * `entity_type` text alone can't say so; `accounts.member_structure` can.
 *
 * The ONE shared test — every caller that decides "build a member roster /
 * multiple signature rows" vs "single owner" MUST use this, not its own
 * text-only check. Dev job 9ad76300-6181-4250-a1de-c77f37933f82 (2026-08-19 second pass): the resolver
 * (lib/members/resolve-signer.ts) got this two-part test, but 3 of the
 * document-building call sites kept their own text-only version, so for the
 * 5 real accounts with this shape the SIGNER resolved correctly while the
 * DOCUMENT still got built and filed as single-member — no roster, one
 * signer, the other owners never got a signature row at all.
 */
export function isMultiMemberEntity(
  entityType: string | null | undefined,
  memberStructure: string | null | undefined,
): boolean {
  return normalizeEntityType(entityType) === 'MMLLC' || memberStructure === 'multi_member'
}
