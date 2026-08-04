/**
 * WHO COUNTS AS A MEMBER, for categorisation. One definition, used everywhere.
 *
 * Member names decide owner draws and owner contributions: money out to a
 * member is equity leaving the company, not a business cost. The matching is a
 * plain case-insensitive SUBSTRING test (see `categorizeTransaction`), which
 * makes the length of a name safety-critical — a member stored as "Ada" would
 * turn Canada, Nevada and Amadeus into owner withdrawals across a whole year.
 * The company-name path has guarded exactly this with a ≥5 floor since the
 * B&P incident ("a short/generic name can never blanket-match vendors"); the
 * member path had no floor at all.
 *
 * WHY THIS FILE EXISTS RATHER THAN A CONSTANT COPIED AROUND (2026-08-04):
 * the floor was first added to the categorisation engine only, leaving the
 * portal ingest path building the list a different way. Two paths with two
 * definitions of "member" is not a cosmetic inconsistency — it is an
 * OSCILLATION. For a member whose name is under the floor, ingest books their
 * payments as owner draws, the periodic re-sort disagrees and rewrites them,
 * the next upload books them back, and the client's capital accounts move
 * every time either path runs. A periodic sweep turns any such divergence into
 * a permanent flip-flop, so the definition has to live in exactly one place.
 *
 * Excluding a name is the SAFE direction: those rows are not auto-booked, so
 * they surface in the client's question queue — visible, and one tap to
 * answer. Silently rebooking a year is the unsafe direction.
 */

/**
 * Shortest full name allowed to auto-book owner draws. Mirrors the own-entity
 * company floor. A name below this is not rejected as a person — it is simply
 * too short to identify safely by substring, so those transactions go to the
 * client to answer instead.
 */
export const MIN_MEMBER_NAME_LENGTH = 5

/** Contact shape both DB-backed builders read. */
export interface MemberNameSource {
  first_name?: string | null
  last_name?: string | null
}

/** Build the safe member-name list from contact rows. Pure. */
export function buildMemberNames(contacts: (MemberNameSource | null | undefined)[]): string[] {
  return contacts
    .filter((c): c is MemberNameSource => !!c)
    .map(c => `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim())
    .filter(isUsableMemberName)
}

/**
 * Apply the same rule to names that arrive already assembled (the standalone
 * P&L workspace stores a single `display_name` per member rather than first +
 * last). Same floor, same reason.
 */
export function filterMemberNames(names: (string | null | undefined)[]): string[] {
  return names.map(n => (n ?? "").trim()).filter(isUsableMemberName)
}

/** The one predicate. Everything above routes through it. */
export function isUsableMemberName(name: string): boolean {
  return name.trim().length >= MIN_MEMBER_NAME_LENGTH
}
