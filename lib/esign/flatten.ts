/**
 * E-Sign flatten — burns field values into the source PDF, server-side, ONCE,
 * when the (last) signer completes. Produces the authoritative signed PDF.
 *
 * Why server-side / once: each signer fills only their own fields; no single
 * browser holds every signature. We accumulate values relationally and flatten
 * here from the pristine source + the full field set.
 *
 * Text/date are drawn with the Unicode font (DejaVu Sans via lib/pdf/unicode-fonts),
 * NOT pdf-lib StandardFonts.Helvetica — Helvetica's WinAnsi encoding throws on
 * accented names (José), € and other non-Latin-1 characters.
 */

import { PDFDocument } from "pdf-lib"
import { normalizedToPdfRect, type NormalizedRect } from "./coordinates"

export type EsignFieldType = "signature" | "initials" | "date" | "text" | "checkbox"

export interface FlattenField extends NormalizedRect {
  field_type: EsignFieldType
  page_index: number
  /** typed text / ISO date / 'true'|'false' for checkbox. */
  value?: string | null
  /** PNG bytes for signature/initials. */
  imageBytes?: Uint8Array | null
  font_size?: number | null
}

/** Aspect-fit (contain) an image of size (imgW,imgH) centered inside a box. Pure. */
export function fitContain(
  imgW: number,
  imgH: number,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  if (imgW <= 0 || imgH <= 0 || box.width <= 0 || box.height <= 0) return { ...box }
  const scale = Math.min(box.width / imgW, box.height / imgH)
  const w = imgW * scale
  const h = imgH * scale
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h }
}

/** Clamp a font size into a sane range that fits the box height. */
export function clampFontSize(fontSize: number | null | undefined, boxHeightPt: number): number {
  const def = 12
  const max = Math.max(6, Math.min(boxHeightPt, 24))
  const v = typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0 ? fontSize : def
  return Math.min(v, max)
}

/** Interpret a checkbox stored value as boolean. */
export function isCheckboxOn(v: string | null | undefined): boolean {
  return v === "true" || v === "1" || v === "yes"
}

/**
 * Flatten `fields` onto `sourcePdf` and return the new PDF bytes. Skips fields
 * on out-of-range pages, empty text, empty/missing signature images, and unticked
 * checkboxes. Refuses rotated pages (via normalizedToPdfRect) rather than
 * misplacing a field.
 */
export async function flattenEsignPdf(
  sourcePdf: Uint8Array,
  fields: FlattenField[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(sourcePdf)
  const { embedUnicodeFonts } = await import("@/lib/pdf/unicode-fonts")
  const { regular } = await embedUnicodeFonts(pdf)
  const pageCount = pdf.getPageCount()

  for (const f of fields) {
    if (!Number.isInteger(f.page_index) || f.page_index < 0 || f.page_index >= pageCount) continue
    const page = pdf.getPage(f.page_index)
    const { width: Wpt, height: Hpt } = page.getSize()
    const rot = page.getRotation().angle
    const rect = normalizedToPdfRect(f, Wpt, Hpt, rot)

    if (f.field_type === "signature" || f.field_type === "initials") {
      if (!f.imageBytes || f.imageBytes.length === 0) continue
      const img = await pdf.embedPng(f.imageBytes)
      const fit = fitContain(img.width, img.height, rect)
      page.drawImage(img, { x: fit.x, y: fit.y, width: fit.width, height: fit.height })
    } else if (f.field_type === "date" || f.field_type === "text") {
      const text = (f.value ?? "").toString()
      if (!text) continue
      const size = clampFontSize(f.font_size, rect.height)
      page.drawText(text, { x: rect.x + 2, y: rect.y + (rect.height - size) / 2, size, font: regular })
    } else if (f.field_type === "checkbox") {
      if (!isCheckboxOn(f.value)) continue
      const size = Math.min(rect.height, 14)
      page.drawText("X", {
        x: rect.x + Math.max(0, (rect.width - size) / 2),
        y: rect.y + Math.max(0, (rect.height - size) / 2),
        size,
        font: regular,
      })
    }
  }

  return await pdf.save()
}
