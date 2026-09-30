/**
 * CRM Store — word-by-word comparison of two files' TEXT (job 685467b5, Antonio 2026-09-30).
 *
 * Two files with the same name but different bytes (a re-saved PDF, a signed and an unsigned copy) can
 * only be called "the same document" if every word matches. This compares the extracted text token by
 * token, so the answer is never "probably": it is either identical, or it lists exactly which words
 * differ. It NEVER decides to delete — a person sees the differences first.
 *
 * Deliberately strict: only invisible differences are ignored (spaces, line breaks, page-break markers,
 * typographic quotes/dashes, Unicode forms). Case, digits, punctuation and every letter still count, so a
 * changed date or a signature mark makes the pair "different".
 */

export interface TextDifference {
  /** where in the first text (word index, 0-based) */
  at: number
  /** words only the first text has */
  onlyInA: string[]
  /** words only the second text has */
  onlyInB: string[]
}

export interface ComparisonResult {
  identical: boolean
  wordsA: number
  wordsB: number
  differences: TextDifference[]
  /** true when the texts differ so much that the differences were not itemised */
  tooDifferentToList: boolean
}

const PAGE_BREAK = /-{2,}\s*page\s*break\s*-{2,}/gi

/** The text as a list of comparable words. Only invisible differences are removed. */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(PAGE_BREAK, " ")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[­​-‍﻿]/g, "")
    .split(/\s+/)
    .filter(Boolean)
}

/** Above this many differing words in the middle, do not try to itemise (the files are not the same document). */
const MAX_MIDDLE = 3000

export function compareTexts(a: string, b: string): ComparisonResult {
  const ta = tokenize(a)
  const tb = tokenize(b)
  const base = { wordsA: ta.length, wordsB: tb.length }
  let start = 0
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) start++
  let endA = ta.length
  let endB = tb.length
  while (endA > start && endB > start && ta[endA - 1] === tb[endB - 1]) { endA--; endB-- }
  if (start === ta.length && start === tb.length) return { identical: true, ...base, differences: [], tooDifferentToList: false }
  const midA = ta.slice(start, endA)
  const midB = tb.slice(start, endB)
  if (midA.length > MAX_MIDDLE || midB.length > MAX_MIDDLE) {
    return { identical: false, ...base, differences: [], tooDifferentToList: true }
  }
  return { identical: false, ...base, differences: diffWords(midA, midB, start), tooDifferentToList: false }
}

/** Longest-common-subsequence diff of two short word lists, grouped into contiguous differences. */
function diffWords(a: string[], b: string[], offset: number): TextDifference[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: TextDifference[] = []
  let cur: TextDifference | null = null
  const flush = () => { if (cur) { out.push(cur); cur = null } }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue }
    if (!cur) cur = { at: offset + i, onlyInA: [], onlyInB: [] }
    if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) { cur.onlyInA.push(a[i]); i++ } else { cur.onlyInB.push(b[j]); j++ }
  }
  flush()
  return out
}
