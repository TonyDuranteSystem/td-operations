/**
 * Shrink the text of one IRS-form text field so it fits the box (instead of being cut off at the right edge).
 *
 * Added 2026-10-13: Antonio's full legal name ("Antonio Noel Durante, Certified Acceptance Agent") is longer than the old short one and
 * no longer fit the W-7 "Name and title" box (~184pt wide) — the printed line was cut at "…Certified Acceptance A". Call this AFTER
 * setting the text and BEFORE form.updateFieldAppearances(font), with the same font that is used for the appearances.
 */
import type { PDFFont, PDFForm } from "pdf-lib"

export function fitFieldText(
  form: PDFForm,
  fieldName: string,
  text: string,
  font: PDFFont,
  opts: { maxSize?: number; minSize?: number; padding?: number } = {},
): number | null {
  const { maxSize = 10, minSize = 5.5, padding = 6 } = opts
  try {
    const field = form.getTextField(fieldName)
    const boxWidth = field.acroField.getWidgets()[0].getRectangle().width
    const widthAtOne = font.widthOfTextAtSize(text, 1)
    if (!(widthAtOne > 0)) return null
    const size = Math.max(minSize, Math.min(maxSize, Math.floor(((boxWidth - padding) / widthAtOne) * 10) / 10))
    field.setFontSize(size)
    return size
  } catch (err) {
    console.warn(`[fit-field] could not fit "${fieldName}":`, err instanceof Error ? err.message : String(err))
    return null
  }
}
