/**
 * A contact's name is stored three ways — first name, last name, and the full name the CRM pages show. The CRM used to edit ONLY the full
 * name, so the other two went stale (a contact re-created as "caterina" / "" kept printing "caterina" on the portal's agreement preview
 * while the CRM showed "Caterina Levoni" — Beril LLC, 2026-10-22). The CRM now edits first and last, and the full name is always built from
 * them, so the three can never disagree. Pure, no I/O.
 */
const MAX_PART = 100

/** Edge spaces and runs of spaces do not belong in a name. Capitals are the person's own and are kept. */
export function cleanNamePart(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/** "Caterina" + "Levoni" → "Caterina Levoni"; a one-name person (empty last name) → just the first name. */
export function composeFullName(first: string | null | undefined, last: string | null | undefined): string {
  return [cleanNamePart(first), cleanNamePart(last)].filter(Boolean).join(' ')
}

export type NameParts = { ok: true; first: string; last: string; full: string } | { ok: false; error: string }

/** What the CRM may save: a first name is required; a last name may be empty (one-name person); neither may be silly long. */
export function validateNameParts(first: string | null | undefined, last: string | null | undefined): NameParts {
  const f = cleanNamePart(first)
  const l = cleanNamePart(last)
  if (!f) return { ok: false, error: 'First name is required.' }
  if (f.length > MAX_PART || l.length > MAX_PART) return { ok: false, error: `A name part can be at most ${MAX_PART} characters.` }
  return { ok: true, first: f, last: l, full: composeFullName(f, l) }
}
