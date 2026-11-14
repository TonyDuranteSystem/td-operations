/**
 * The "Starts with" A to Z filter on the Accounts and Contacts lists.
 *
 * A name's letter is its first character with accents removed ("Élan" -> E), upper-cased. A name that starts with anything that is not
 * a plain letter (a dash, a number, a quote, nothing at all) goes under "#". Pure and client-safe.
 */

export const LETTER_OTHER = '#'
export const LETTERS: readonly string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export function nameInitial(name: string | null | undefined): string {
  const first = (name ?? '').trim().charAt(0)
  if (!first) return LETTER_OTHER
  const base = first.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  return /^[A-Z]$/.test(base) ? base : LETTER_OTHER
}

/** URL value -> '' (no letter picked), 'A'..'Z' or '#'. Anything else is ignored. */
export function parseLetter(raw: string | string[] | undefined): string {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase() ?? ''
  return v === LETTER_OTHER || LETTERS.includes(v) ? v : ''
}

export function letterMatches(name: string | null | undefined, letter: string): boolean {
  return !letter || nameInitial(name) === letter
}

/** How many names start with each letter (and how many in all), for the greyed-out and numbered buttons. */
export function letterCounts(names: (string | null | undefined)[]): { all: number; byLetter: Record<string, number> } {
  const byLetter: Record<string, number> = {}
  for (const n of names) {
    const l = nameInitial(n)
    byLetter[l] = (byLetter[l] ?? 0) + 1
  }
  return { all: names.length, byLetter }
}
