/**
 * File Understanding — are two files the same DOCUMENT? (job 685467b5). The exact word comparison
 * (`content-compare.ts`) is the EVIDENCE; this turns it into a safe verdict:
 *   · every word equal                                   → same_words
 *   · only stray non-numeric marks differ (a signature read as "ΑΣ Α2", a stamp) → minor_marks  (a person confirms)
 *   · any real NUMBER or DATE differs ($8,000 vs $800, 03/10/2024 vs 03/11/2024) → different_words, ALWAYS,
 *     whatever the AI says and however few words differ
 *   · many differing words                               → different_words
 * The AI (see judge.ts) may EXPLAIN a pair but can never turn a numeric difference into "same".
 */
import { createHash } from "crypto"
import { compareTexts, tokenize, type ComparisonResult, type TextDifference } from "@/lib/crm-store/content-compare"

export type PairVerdict = "same_bytes" | "same_words" | "minor_marks" | "different_words" | "not_compared"

/** A token that carries a real number or date: two or more digits, or only digits and number punctuation/currency. */
export function isMaterialToken(t: string): boolean {
  if (/\d{2,}/.test(t)) return true
  return /^[$€£¥(]?\d[\d.,/:%)-]*$/.test(t)
}

/** Does a differing token look like scan/ink NOISE (a signature read as "ΑΣ", a stamp, a stray "Α2") rather than a real
 *  word someone wrote? Real Latin words of 3+ letters ("Second", "Rossi") are content, never noise. */
export function isMarkLike(t: string): boolean {
  if (/[^\u0000-\u024F]/.test(t)) return true                            // Greek, Cyrillic, symbols outside Latin
  if (!/[A-Za-z]/.test(t)) return true                                   // punctuation / digits only
  if (/[A-Za-z]/.test(t) && /\d/.test(t)) return true                    // letters fused with digits
  return t.length <= 2                                                   // "AS", "x"
}

export function normHash(text: string): string {
  return createHash("sha256").update(tokenize(text).join(" ")).digest("hex")
}

export interface PairAssessment {
  verdict: PairVerdict
  wordsA: number
  wordsB: number
  differences: TextDifference[]
  materialDifferences: string[]
  note: string
}

export function assessPair(textA: string, textB: string, opts: { sameBytes?: boolean } = {}): PairAssessment {
  if (opts.sameBytes) return { verdict: "same_bytes", wordsA: 0, wordsB: 0, differences: [], materialDifferences: [], note: "Identical files (every byte)." }
  if (!textA.trim() || !textB.trim()) {
    return { verdict: "not_compared", wordsA: 0, wordsB: 0, differences: [], materialDifferences: [], note: "The words of one or both files could not be read, so they were not compared." }
  }
  const c: ComparisonResult = compareTexts(textA, textB)
  if (c.identical) return { verdict: "same_words", wordsA: c.wordsA, wordsB: c.wordsB, differences: [], materialDifferences: [], note: "Every word is the same." }
  if (c.tooDifferentToList) return { verdict: "different_words", wordsA: c.wordsA, wordsB: c.wordsB, differences: [], materialDifferences: [], note: "The words differ a lot — not the same document." }
  const changed = c.differences.flatMap((d) => [...d.onlyInA, ...d.onlyInB])
  const material = changed.filter(isMaterialToken)
  if (material.length > 0) {
    return { verdict: "different_words", wordsA: c.wordsA, wordsB: c.wordsB, differences: c.differences, materialDifferences: material, note: `A number or date differs (${material.slice(0, 4).join(", ")}) — these are different documents.` }
  }
  const budget = Math.max(4, Math.floor(Math.max(c.wordsA, c.wordsB) * 0.005))
  if (changed.length <= budget && changed.every(isMarkLike)) {
    return { verdict: "minor_marks", wordsA: c.wordsA, wordsB: c.wordsB, differences: c.differences, materialDifferences: [], note: `Same words except ${changed.length} stray mark(s): “${changed.slice(0, 6).join(" ")}” — probably a signature or stamp. Please confirm.` }
  }
  return { verdict: "different_words", wordsA: c.wordsA, wordsB: c.wordsB, differences: c.differences, materialDifferences: [], note: `${changed.length} words differ — not the same document.` }
}
