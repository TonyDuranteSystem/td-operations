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
