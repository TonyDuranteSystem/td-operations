/**
 * WHO COUNTS AS A MEMBER, for categorisation. One definition, used everywhere.
 *
 * Member names decide owner draws and owner contributions: money out to a
 * member is equity leaving the company, not a business cost. The matching is a
 * SUBSTRING test (see `categorizeTransaction`), which makes what qualifies as a
 * name safety-critical.
 *
 * WHY THIS FILE EXISTS RATHER THAN A CONSTANT COPIED AROUND (2026-08-04):
 * the rule was first added to the categorisation engine only, leaving the
 * portal ingest path building the list a different way. Two paths with two
 * definitions of "member" is not a cosmetic inconsistency — it is an
 * OSCILLATION. For a name one path accepts and the other rejects, ingest books
 * the payments as owner draws, the periodic re-sort disagrees and rewrites
 * them, the next upload books them back, and the client's capital accounts move
 * every time either path runs. A periodic sweep turns any such divergence into
 * a permanent flip-flop, so the definition has to live in exactly one place.
 *
 * WHY THE BAR IS "A REAL FULL NAME" AND NOT A CHARACTER COUNT (2026-08-04):
 * the first cut used `length >= 5`, an invented number. Two findings killed it.
 *
 *  1. EMPTY NAMES ARE THE ACTUAL HAZARD, AND THEY ARE REAL. In JavaScript
 *     `"anything".includes("") === true`. Ten linked contact records across six
 *     companies that HAVE bank data carry NULL first AND last name (Aumianna,
 *     Economicamente, Nexo Agency, PAMAG ×3, VSV210, Zhang Holding — verified
 *     on production 2026-08-04). Each builds the empty string. One of those in
 *     the list blanket-matches EVERY row of the year: all income becomes
 *     "owner contribution", all spending becomes "owner draw", and the P&L
 *     reads zero income and zero expenses. Economicamente was preparing their
 *     return at the time. The floor was the only thing standing in the way.
 *  2. A SINGLE WORD IS NOT AN IDENTIFICATION. "Marco" clears any length bar and
 *     still matches "Marco Polo Trading Ltd". Requiring first AND last name is
 *     the honest version of what the character count was groping towards.
 *
 * So: at least two name parts, each of a sensible length, after normalising —
 * and never, under any circumstance, an empty or whitespace-only string.
 *
 * NORMALISATION IS PART OF THE DEFINITION, not a nicety. Banks send "JOSE
 * MUNOZ" where the CRM holds "Josè Muñoz". Comparing raw lowercase strings
 * misses that, and a MISSED member is the dangerous direction: their draw is
 * silently deducted as a business cost. Accents are stripped and case folded on
 * BOTH sides of every comparison.
 */

/**
 * At least ONE part of the name must reach this length, to carry some identity.
 *
 * NOT "every part" — that was the first cut and it silently dropped company
 * members, whose names are full of initials: "F.INVEST Holding LLC" and
 * "B&P International LLC" both split to a one-letter first part. A dropped
 * company member is the dangerous direction (their distribution becomes a
 * deducted expense), and the test for it is in tests/unit/member-names.test.ts.
 */
export const MIN_NAME_PART_LENGTH = 3

/** A name must have at least this many parts — i.e. a first AND a last name. */
export const MIN_NAME_PARTS = 2

/**
 * Shortest the whole normalised name may be. Guards the degenerate pair ("a b",
 * "li wu") that clears the part count but identifies nobody.
 */
export const MIN_FULL_NAME_LENGTH = 5

/**
 * Shortest a SURNAME may be to raise a near-miss question (below). Deliberately
 * stricter than a general name part: this one only produces a question for the
 * client, but a flood of questions is its own kind of broken.
 */
export const MIN_SURNAME_LENGTH = 4

/**
 * Fold a name or a bank description to the form both sides are compared in:
 * accents stripped, case folded, punctuation reduced to spaces, runs of
 * whitespace collapsed. Pure.
 */
export function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    // Combining diacritical marks — "è" becomes "e", "ñ" becomes "n".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Punctuation and separators become spaces so "Rossi,Mario" and
    // "ROSSI/MARIO" both split into parts the same way.
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

/** The parts of a name, normalised. Empty array for a nameless record. */
export function nameParts(name: string | null | undefined): string[] {
  const n = normalizeForMatch(name)
  return n ? n.split(" ").filter(Boolean) : []
}

/** Contact shape the DB-backed builders read. */
export interface MemberNameSource {
  first_name?: string | null
  last_name?: string | null
}

/**
 * THE ONE PREDICATE. Everything routes through it.
 *
 * A usable member name is more than one word, long enough overall to identify
 * somebody, and carries at least one substantial part. Anything less is not
 * rejected as "not a person" — it is simply too weak to auto-book money on, so
 * those rows go to the client to answer instead.
 *
 * Three conditions, each earning its place:
 *  - NOT EMPTY and more than one word — a blank matches every row of the year
 *    (the production case), and a lone "Marco" matches "Marco Polo Trading Ltd";
 *  - long enough overall — "a b" and "li wu" clear the word count and identify
 *    nobody;
 *  - one substantial part — so initials-heavy company members ("B&P
 *    International LLC") still qualify, while "a b c" does not.
 *
 * Excluding is the SAFE direction for a PERSON: a visible question beats
 * silently wrong money. But excluding a COMPANY member is not safe, which is
 * why the length test is on the whole name rather than on every part.
 */
export function isUsableMemberName(name: string | null | undefined): boolean {
  const normalized = normalizeForMatch(name)
  if (normalized.length < MIN_FULL_NAME_LENGTH) return false
  const parts = nameParts(name)
  if (parts.length < MIN_NAME_PARTS) return false
  return parts.some(p => p.length >= MIN_NAME_PART_LENGTH)
}

/** Build the safe member-name list from contact rows. Pure. */
export function buildMemberNames(contacts: (MemberNameSource | null | undefined)[]): string[] {
  return dedupeMemberNames(
    contacts
      .filter((c): c is MemberNameSource => !!c)
      .map(c => `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim())
      .filter(isUsableMemberName),
  )
}

/**
 * Apply the same rule to names that arrive already assembled — the curated
 * members list holds one `full_name` (or `company_name` for a company member),
 * and the standalone P&L workspace stores a single `display_name`.
 */
export function filterMemberNames(names: (string | null | undefined)[]): string[] {
  return dedupeMemberNames(
    names.map(n => (n ?? "").trim()).filter(isUsableMemberName),
  )
}

/**
 * Merge rosters, best source first, removing duplicates that differ only by
 * accent or case ("Josè Muñoz" and "Jose Munoz" are one member, and feeding
 * both to the matcher would double-count nothing but does make the "Member: X"
 * note non-deterministic between runs).
 */
export function dedupeMemberNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const key = normalizeForMatch(n)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

/**
 * Does this text name a member? Accent- and case-insensitive, and matched on
 * whole words so "Ada Rossi" cannot hide inside "Canada Rossignol".
 *
 * Returns the member's name as stored (for the note), not the matched text.
 */
export function matchMemberName(text: string | null | undefined, memberNames: string[]): string | null {
  const hay = normalizeForMatch(text)
  if (!hay) return null
  for (const name of memberNames) {
    const needle = normalizeForMatch(name)
    if (!needle) continue
    if (containsWholePhrase(hay, needle)) return name
  }
  return null
}

/**
 * WHOLE-WORD containment. `String.includes` on normalised text would let a
 * member "Ada Rossi" match "canada rossini"; requiring word boundaries at both
 * ends does not. Both sides are already normalised to single-spaced a-z0-9.
 */
function containsWholePhrase(hay: string, needle: string): boolean {
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 || hay[at - 1] === " "
    const afterIdx = at + needle.length
    const after = afterIdx === hay.length || hay[afterIdx] === " "
    if (before && after) return true
    from = at + 1
  }
}

/**
 * Markers separating the PAYEE from the payment reference. A member's name
 * after one of these describes what the payment was FOR, not who received it.
 * Normalised form (lowercase, no punctuation), matched on word boundaries.
 */
const REFERENCE_MARKERS = [
  "with reference", "reference", "ref", "causale", "concepto", "concept",
  "motivo", "for invoice", "invoice", "fattura", "factura",
]

/**
 * The part of the line that identifies WHO was paid — everything before the
 * first payment-reference marker. Returns the whole normalised line when there
 * is no marker (the common case: "Sent money to Enrico Berini").
 */
export function payeePart(text: string | null | undefined): string {
  const hay = normalizeForMatch(text)
  if (!hay) return ""
  let cut = hay.length
  for (const marker of REFERENCE_MARKERS) {
    // Word-boundary search so "ref" does not fire inside "refund".
    const padded = ` ${hay} `
    const at = padded.indexOf(` ${marker} `)
    if (at !== -1 && at < cut) cut = at
  }
  const head = hay.slice(0, cut).trim()
  // A marker at the very start ("REF: Berini payment") would cut the line down
  // to nothing and silently switch the near-miss check OFF for that entire bank
  // format — a member payment would go back to being deducted in silence.
  // With no payee half to read, search the WHOLE line: the worst case is one
  // extra question for the client, against a wrong number nobody sees.
  return head || hay
}

/**
 * THE UNCERTAIN CASE — ask the client instead of guessing (Antonio, 2026-08-04:
 * "is it so hard to make the question to the client for an uncertain
 * transaction?").
 *
 * A near miss is a payment whose text carries a member's SURNAME but not their
 * full name: "Sent money to M. Finelli" when the members are Gabriele Finelli
 * and Matthew Finelli. Today that falls through to the generic catch-all and is
 * booked as a vendor expense — an owner draw silently deducted.
 *
 * Deliberately narrow. It is NOT "the payee looks like a person": that would
 * cover 946 payments across 136 payees book-wide, nearly all of them genuine
 * suppliers (one alone is 302 payments), and burying the client in questions
 * they cannot answer is a worse product, not a safer one. It is only "this
 * looks like it might be one of THIS company's own members".
 *
 * Only the surname counts — a first name like "Marco" would question every
 * vendor called Marco. Returns the member whose surname matched, or null.
 */
/**
 * Tokens that mark a name as a COMPANY rather than a person. Used only to
 * switch the near-miss check OFF — a company is identified by its full legal
 * name, which the exact matcher already handles.
 */
const COMPANY_TOKENS: ReadonlySet<string> = new Set([
  "llc", "ltd", "limited", "inc", "incorporated", "corp", "corporation", "co",
  "gmbh", "srl", "srls", "spa", "sas", "sarl", "bv", "nv", "ab", "oy", "ou",
  "plc", "llp", "lp", "holding", "holdings", "group", "trading", "capital",
  "ventures", "solutions", "services", "consulting", "partners", "sa", "ag",
])

/** Does this roster name look like a company rather than a person? */
export function looksLikeCompany(name: string): boolean {
  return nameParts(name).some(p => COMPANY_TOKENS.has(p))
}

export function findNearMissMembers(text: string | null | undefined, memberNames: string[]): string[] {
  // EVERY member whose surname matches, not just the first.
  //
  // Two owners sharing a surname is not exotic — Titan's members are Gabriele
  // and Matthew Finelli. Returning only the first meant the card offered one
  // name, so a client whose payment went to the OTHER one had no way to say so:
  // they either credited the wrong partner's K-1 or answered "not an owner",
  // and both are wrong. The client picks; we only narrow the field.
  if (matchMemberName(text, memberNames)) return []
  const hay = payeePart(text)
  if (!hay) return []
  const out: string[] = []
  for (const name of memberNames) {
    if (looksLikeCompany(name)) continue
    const parts = nameParts(name)
    if (parts.length < MIN_NAME_PARTS) continue
    const surname = parts[parts.length - 1]
    if (surname.length < MIN_SURNAME_LENGTH) continue
    if (containsWholePhrase(hay, surname)) out.push(name)
  }
  return out
}

/** Separator between suspected members inside the mark. */
export const SUSPECTED_SEP = "; "

/** Every suspected member carried by a row's note. The single reader. */
export function suspectedMembersFromNotes(notes: string | null | undefined): string[] {
  const n = (notes ?? "").trim()
  if (!n.startsWith(ASK_CLIENT_NOTE)) return []
  // Cut at the first " | " — rows written before that fix carry an appended
  // "| Related entity: X", and this tail is rendered to the client AS A NAME.
  const tail = n.slice(ASK_CLIENT_NOTE.length).split(" | ")[0]
  return tail.split(SUSPECTED_SEP).map(x => x.trim()).filter(Boolean)
}

export function findNearMissMember(text: string | null | undefined, memberNames: string[]): string | null {
  // An exact match is not a near miss — that path books the row outright.
  if (matchMemberName(text, memberNames)) return null
  // Only the PAYEE half of the line counts, never the payment reference. Found
  // by replaying production: "Sent money to Lope Gómez Ibáñez with reference
  // Marinoni factura 2024-005" is a payment to a Spanish supplier whose invoice
  // happens to mention a member — asking the client about it is pure noise.
  // A genuine near miss names the person where the payee goes, before any
  // "with reference" / "ref:" / "causale" tail.
  const hay = payeePart(text)
  if (!hay) return null
  for (const name of memberNames) {
    // A COMPANY member has no surname. Taking the last word of a legal name
    // gives you "Limited", "Holdings" or "GmbH" — which would then question
    // every UK or German supplier on the books, the exact flood this function
    // exists to avoid. A company is identified by its full legal name, and
    // `matchMemberName` already does that exactly.
    if (looksLikeCompany(name)) continue
    const parts = nameParts(name)
    if (parts.length < MIN_NAME_PARTS) continue
    const surname = parts[parts.length - 1]
    if (surname.length < MIN_SURNAME_LENGTH) continue
    if (containsWholePhrase(hay, surname)) return name
  }
  return null
}

/**
 * Prefix marking a row the system deliberately REFUSED to guess — the payee
 * carries a member's surname but not their full name — followed by the
 * suspected member's name.
 *
 * This mark, NOT the category, is what makes the row a question. Everything
 * that must respect it:
 *  - the AI pass is forbidden from resolving a row carrying it, so a guess can
 *    never answer the question on the client's behalf and seal it;
 *  - the periodic re-sort writes and clears it even when no category moves;
 *  - the client's review screen promotes marked rows into "Needs your
 *    decision" and names the suspected member on the card;
 *  - the client's own answer overwrites it, which is how it self-clears.
 *
 * IT LIVES HERE, not with the statement parser, because the review SCREEN reads
 * it: the parser pulls in the PDF library and Node's filesystem, so importing
 * it from a client component breaks the browser build outright.
 */
export const ASK_CLIENT_NOTE = "ask: possible payment to member"

/**
 * The suspected member's name carried by a row's note, or null. The single
 * reader — the review screens, the validation panel and the engine all use it,
 * so the note's shape is defined in exactly one place.
 */
export function suspectedMemberFromNotes(notes: string | null | undefined): string | null {
  return suspectedMembersFromNotes(notes)[0] ?? null
}
