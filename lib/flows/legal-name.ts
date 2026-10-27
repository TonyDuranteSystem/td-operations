/**
 * The legal name of a formation company — ONE rule, used everywhere the name of a new company is decided
 * (the Articles-upload pre-check, the advance gate, the company creation, the duplicate check) so they can never
 * disagree again. Job 80cce1cb (2026-10-27): the company was created from the name staff marked "filed", exactly as
 * the client typed it ("Tanto per"), so about 1 formation in 5 came out without its LLC ending and was fixed by hand.
 *
 * PURE and client-safe (no I/O, no regex lookbehind, no /u flag — the repo targets ES5). Idempotent:
 * legalNameFor(legalNameFor(x).name).name === legalNameFor(x).name.
 *
 * What counts as a valid ending is deliberately the union of what the four formation states accept (NM, WY, FL, DE):
 * LLC, L.L.C., LC, L.C., PLLC, "Limited Liability Company/Co", "Limited Company". A name that already carries one is
 * never doubled ("Acme L.L.C. LLC"). A name that ends in a clearly NON-LLC type (Inc, Corp, LP, LLP, Ltd, Limited…)
 * is refused instead of guessed — only inside the formation flow (real corporations exist elsewhere in the CRM).
 */

/** Max length of a company legal name (matches MAX_STAFF_NAME_LENGTH for typed names). */
export const MAX_LEGAL_NAME_LENGTH = 120

// Zero-width / BOM / word-joiner, then ASCII + C1 control characters.
const INVISIBLE = /[​-‍⁠﻿]/g
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
// Line/tab-style breaks are word separators, not deletions ("Acme\tStudio" is two words).
const BREAKS = /[\t\n\r\u000B\u000C\u0085\u2028\u2029]/g

/** NFKC, invisible/control characters removed, every kind of space → one space, trimmed. Not a string → "". */
export function cleanNameText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let s = raw
  try {
    s = s.normalize('NFKC')
  } catch {
    /* very old engines: keep as is */
  }
  return s.replace(INVISIBLE, '').replace(BREAKS, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim()
}

// A valid ending: at the very end, after the start of the name, a space or a comma (so "Delc" is not "…LC").
const VALID_ENDING =
  /(?:^|[\s,])(limited liability company|limited liability co|limited company|p\.?\s?l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?c|l\.?\s?c)$/i
// A clearly non-LLC company type. "Co" / "Company" are NOT here: "Tapeo Company" simply gets " LLC".
const BLOCKED_ENDING =
  /(?:^|[\s,])(incorporated|inc|corporation|corp|l\.?\s?l\.?\s?l\.?\s?p|l\.?\s?l\.?\s?p|l\.?\s?p|ltd|limited)$/i

/** Trailing separators/quotes/closers removed (a final period is handled separately: "L.L.C." keeps its dot). */
function stripTrailing(text: string): string {
  return text.replace(/[\s,;:'"‘’“”)\]]+$/, '').trim()
}

function withoutFinalDot(text: string): string {
  return text.replace(/\.$/, '').trim()
}

/** Does the name already end in a valid LLC ending (any case, any state's variant)? */
export function hasValidLlcEnding(raw: unknown): boolean {
  const t = stripTrailing(cleanNameText(raw))
  return VALID_ENDING.test(withoutFinalDot(t))
}

/** The type word of a clearly non-LLC ending ("Inc", "Corp", "LLP"…), or null. */
export function blockedEndingOf(raw: unknown): string | null {
  const t = withoutFinalDot(stripTrailing(cleanNameText(raw)))
  if (VALID_ENDING.test(t)) return null
  const m = t.match(BLOCKED_ENDING)
  return m ? m[1] : null
}

/** Plain record (not a discriminated union): the repo's `strict: false` does not narrow unions on `ok`. On failure `name` is the text as it was. */
export interface LegalNameResult {
  ok: boolean
  name: string
  change: 'none' | 'recased' | 'added'
  reason?: 'empty' | 'blocked_ending' | 'too_long'
  detail?: string
}

/**
 * The legal name for a name the client/staff chose.
 *  - already ends in a valid ending → kept as typed (only a lowercase/mixed-case "llc" becomes "LLC")
 *  - no ending → " LLC" added
 *  - ends in Inc / Corp / LP / LLP / Ltd / Limited… → refused with a plain sentence (never guessed)
 */
export function legalNameFor(raw: unknown): LegalNameResult {
  const text = stripTrailing(cleanNameText(raw))
  if (!text) return { ok: false, name: '', change: 'none', reason: 'empty', detail: 'There is no company name yet.' }
  const core = withoutFinalDot(text)

  const m = core.match(VALID_ENDING)
  if (m) {
    const ending = m[1]
    // Keep a dotted ending's final period ("Acme L.L.C."), drop a stray one after a plain ending ("Acme LLC.").
    const keepDot = text.endsWith('.') && ending.indexOf('.') !== -1
    let name = keepDot ? `${core}.` : core
    let change: 'none' | 'recased' = 'none'
    if (/^llc$/i.test(ending) && ending !== 'LLC') {
      name = `${core.slice(0, core.length - ending.length)}LLC`
      change = 'recased'
    }
    return finish(name, change)
  }

  const blocked = core.match(BLOCKED_ENDING)
  if (blocked) {
    return {
      ok: false,
      name: core,
      change: 'none',
      reason: 'blocked_ending',
      detail: `The name "${core}" ends in "${blocked[1]}", which is not an LLC ending. Fix the company name first (it must end in LLC, L.L.C. or Limited Liability Company).`,
    }
  }
  return finish(`${core} LLC`, 'added')
}

function finish(name: string, change: 'none' | 'recased' | 'added'): LegalNameResult {
  if (name.length > MAX_LEGAL_NAME_LENGTH) {
    return { ok: false, name, change: 'none', reason: 'too_long', detail: `The company name is longer than ${MAX_LEGAL_NAME_LENGTH} characters.` }
  }
  return { ok: true, name, change }
}

/** TOTAL display form (never refuses, never throws): the legal name when there is one, else the text as it is. */
export function displayLegalName(raw: unknown): string {
  const r = legalNameFor(raw)
  if (r.ok) return r.name
  return cleanNameText(raw)
}

const COMBINING_MARKS = /[̀-ͯ]/g

/**
 * "Is this the same company name?" key: capitals, accents, spaces, punctuation and the LLC ending are ignored, so
 * "Tanto per", "TANTO PER, L.L.C." and "Tanto Per LLC" are one name. Used by the duplicate-company check and by the
 * staff-confirmed-name check. A different WORD makes a different key. Empty string = no usable name.
 */
export function canonicalNameKey(raw: unknown): string {
  let t = withoutFinalDot(stripTrailing(cleanNameText(raw)))
  // Strip at most one valid ending (twice for a pasted "Acme LLC LLC").
  for (let i = 0; i < 2; i++) {
    const m = t.match(VALID_ENDING)
    if (!m) break
    t = stripTrailing(t.slice(0, t.length - m[0].length))
  }
  let folded = t.toLowerCase()
  try {
    folded = folded.normalize('NFKD').replace(COMBINING_MARKS, '')
  } catch {
    /* keep */
  }
  return folded.replace(/[\s.,;:'"‘’“”()&\-_/\\!?]+/g, '')
}

/** True when both names are the same company name apart from capitals / punctuation / the ending. */
export function sameCompanyName(a: unknown, b: unknown): boolean {
  const ka = canonicalNameKey(a)
  return ka !== '' && ka === canonicalNameKey(b)
}

export interface ConfirmedNameResult {
  ok: boolean
  /** The confirmed name when ok, '' otherwise. */
  name: string
  /** The plain sentence for staff when not ok. */
  error?: string
}

/**
 * Validates the legal name STAFF confirmed in the Articles window (the name exactly as printed on the Articles).
 * It is NOT re-cased or re-decorated — what staff confirmed is what is stored. It must carry a valid ending, and it
 * must be the same name as the filed one apart from capitals / punctuation / ending, unless staff explicitly ticked
 * that the Articles really print a different name.
 */
export function validateConfirmedLegalName(input: {
  confirmed: unknown
  /** The name staff marked as filed in the Names panel (or the wizard's chosen name when nothing is filed). */
  referenceName?: unknown
  /** Staff ticked "The Articles name differs from the filed name". */
  articlesDiffer?: boolean
}): ConfirmedNameResult {
  const name = stripTrailing(cleanNameText(input.confirmed))
  if (!name) return { ok: false, name: '', error: 'Enter the company legal name exactly as it is printed on the Articles.' }
  if (name.length > MAX_LEGAL_NAME_LENGTH) {
    return { ok: false, name: '', error: `The company legal name is longer than ${MAX_LEGAL_NAME_LENGTH} characters.` }
  }
  if (!hasValidLlcEnding(name)) {
    const blocked = blockedEndingOf(name)
    return {
      ok: false,
      name: '',
      error: blocked
        ? `The name ends in "${blocked}", which is not an LLC ending. Enter the name as printed on the Articles (it must end in LLC, L.L.C. or Limited Liability Company).`
        : 'The legal name must end in LLC, L.L.C. or Limited Liability Company, as printed on the Articles.',
    }
  }
  const reference = cleanNameText(input.referenceName)
  if (reference && !input.articlesDiffer && !sameCompanyName(name, reference)) {
    return {
      ok: false,
      name: '',
      error: `This name differs from the filed name "${reference}". If the Articles really print it this way, tick "The Articles name differs from the filed name"; otherwise correct it.`,
    }
  }
  return { ok: true, name }
}

export interface FormationNameResolution {
  ok: boolean
  /** The company legal name when ok, '' otherwise. */
  name: string
  source: 'confirmed' | 'filed' | 'wizard'
  change: 'none' | 'recased' | 'added'
  /** Only when not ok. */
  reason?: 'empty' | 'blocked_ending' | 'too_long'
  detail?: string
  /** The name the resolver started from (filed / wizard), as it was — only when not ok. */
  base?: string
}

/**
 * THE one place a formation company's name is decided (pre-check, advance gate and materializer all call it).
 *  1. a name staff confirmed on the Articles window (saved on the filed name) wins, untouched;
 *  2. else the filed name, else the wizard's final / chosen name — through legalNameFor.
 */
export function resolveFormationLegalName(input: {
  confirmedLegalName?: unknown
  filedName?: unknown
  wizardFinalName?: unknown
  wizardChosenName?: unknown
}): FormationNameResolution {
  const confirmed = stripTrailing(cleanNameText(input.confirmedLegalName))
  if (confirmed) return { ok: true, name: confirmed, source: 'confirmed', change: 'none' }

  const filed = cleanNameText(input.filedName)
  const wizardFinal = cleanNameText(input.wizardFinalName)
  const wizardChosen = cleanNameText(input.wizardChosenName)
  const base = filed || wizardFinal || wizardChosen
  const source: 'filed' | 'wizard' = filed ? 'filed' : 'wizard'
  const r = legalNameFor(base)
  if (r.ok) return { ok: true, name: r.name, source, change: r.change }
  return { ok: false, name: '', source, change: 'none', reason: r.reason, detail: r.detail, base }
}
