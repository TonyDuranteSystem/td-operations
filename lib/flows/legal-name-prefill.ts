/**
 * What the Articles-upload window puts in its "Company legal name" field (job 80cce1cb). Pure and client-safe.
 *
 * The field is what staff CONFIRM, the same way they confirm the filing date: the Articles' own spelling is only a PREFILL
 * (OCR can be wrong — a wrapped line, a truncated name, an I/l confusion), never decided silently.
 *   - Articles name read, valid ending, same words as the filed name  → prefill the Articles' exact spelling;
 *   - Articles name read but a DIFFERENT word                         → prefill the filed-derived name and offer the Articles name
 *                                                                        as one click ("Use the Articles name") — never auto-picked;
 *   - nothing readable                                                → the filed-derived name (the ending rule applied).
 */
import { cleanNameText, hasValidLlcEnding, sameCompanyName, MAX_LEGAL_NAME_LENGTH } from '@/lib/flows/legal-name'

export interface LegalNamePrefill {
  /** What goes in the field. */
  value: string
  /** The name read off the Articles when it is usable (valid ending, sane length); null when nothing usable was read. */
  articlesName: string | null
  /** The Articles name has different WORDS from the filed name — the window shows a warning and a "Use the Articles name" button. */
  articlesDiffers: boolean
}

export function suggestLegalName(input: {
  /** The name the check says the company would get (filed name + the ending rule), or null when it cannot be used as it stands. */
  legalName?: string | null
  /** The filed name (or wizard name) as it is — the reference the words are compared with. */
  referenceName?: string | null
  /** What the Articles reader returned (may be null / partial / wrong). */
  articlesName?: string | null
}): LegalNamePrefill {
  const reference = cleanNameText(input.referenceName)
  const base = cleanNameText(input.legalName) || reference
  const articles = cleanNameText(input.articlesName)
  const usable = articles !== '' && articles.length <= MAX_LEGAL_NAME_LENGTH && hasValidLlcEnding(articles)

  if (!usable) return { value: base, articlesName: null, articlesDiffers: false }
  if (!reference || sameCompanyName(articles, reference)) {
    return { value: articles, articlesName: articles, articlesDiffers: false }
  }
  return { value: base, articlesName: articles, articlesDiffers: true }
}

/** True when the typed legal name has different words from the filed name — then staff must tick "The Articles name differs". */
export function legalNameNeedsDifferTick(value: unknown, referenceName: unknown): boolean {
  const v = cleanNameText(value)
  const ref = cleanNameText(referenceName)
  return v !== '' && ref !== '' && !sameCompanyName(v, ref)
}
