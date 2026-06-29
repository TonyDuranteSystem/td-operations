import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { flattenEsignPdf, fitContain, clampFontSize, isCheckboxOn, type FlattenField } from '@/lib/esign/flatten'

// A minimal valid 1x1 transparent PNG.
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
)

async function makePdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792])
  return await doc.save()
}

describe('fitContain', () => {
  it('centers and scales-to-fit preserving aspect ratio', () => {
    // 200x100 image into a 100x100 box → scale 0.5 → 100x50, vertically centered.
    const fit = fitContain(200, 100, { x: 0, y: 0, width: 100, height: 100 })
    expect(fit.width).toBeCloseTo(100, 6)
    expect(fit.height).toBeCloseTo(50, 6)
    expect(fit.x).toBeCloseTo(0, 6)
    expect(fit.y).toBeCloseTo(25, 6) // (100-50)/2
  })
  it('returns the box unchanged for degenerate image size', () => {
    const box = { x: 1, y: 2, width: 3, height: 4 }
    expect(fitContain(0, 10, box)).toEqual(box)
  })
})

describe('clampFontSize / isCheckboxOn', () => {
  it('defaults to 12 and caps to box height (max 24)', () => {
    expect(clampFontSize(null, 100)).toBe(12)
    expect(clampFontSize(40, 100)).toBe(24)   // capped at 24
    expect(clampFontSize(10, 8)).toBe(8)       // capped at box height
  })
  it('reads truthy checkbox values', () => {
    expect(isCheckboxOn('true')).toBe(true)
    expect(isCheckboxOn('false')).toBe(false)
    expect(isCheckboxOn(null)).toBe(false)
  })
})

describe('flattenEsignPdf', () => {
  it('renders all field types and returns a valid PDF with the same page count', async () => {
    const src = await makePdf(2)
    const fields: FlattenField[] = [
      // UNICODE regression: accented name + € must NOT throw (the Helvetica bug).
      { field_type: 'text', page_index: 0, pos_x: 0.1, pos_y: 0.1, width: 0.5, height: 0.03, value: 'José Núñez — €100,00' },
      { field_type: 'date', page_index: 0, pos_x: 0.1, pos_y: 0.2, width: 0.3, height: 0.03, value: '06/26/2026' },
      { field_type: 'checkbox', page_index: 0, pos_x: 0.8, pos_y: 0.1, width: 0.03, height: 0.03, value: 'true' },
      { field_type: 'signature', page_index: 1, pos_x: 0.1, pos_y: 0.85, width: 0.3, height: 0.05, imageBytes: PNG_1x1 },
    ]
    const out = await flattenEsignPdf(src, fields)
    expect(out.length).toBeGreaterThan(src.length) // embedded font + content added
    const reloaded = await PDFDocument.load(out)    // must be a valid PDF
    expect(reloaded.getPageCount()).toBe(2)
  })

  it('skips out-of-range pages, empty values, missing images, unticked checkboxes', async () => {
    const src = await makePdf(1)
    const fields: FlattenField[] = [
      { field_type: 'text', page_index: 5, pos_x: 0.1, pos_y: 0.1, width: 0.5, height: 0.03, value: 'off-page' },
      { field_type: 'text', page_index: 0, pos_x: 0.1, pos_y: 0.1, width: 0.5, height: 0.03, value: '' },
      { field_type: 'signature', page_index: 0, pos_x: 0.1, pos_y: 0.5, width: 0.3, height: 0.05, imageBytes: null },
      { field_type: 'checkbox', page_index: 0, pos_x: 0.8, pos_y: 0.1, width: 0.03, height: 0.03, value: 'false' },
    ]
    const out = await flattenEsignPdf(src, fields) // must not throw
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(1)
  })

  it('refuses a rotated page rather than misplacing the field', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    page.setRotation({ type: 'degrees', angle: 90 } as never)
    const src = await doc.save()
    const fields: FlattenField[] = [
      { field_type: 'text', page_index: 0, pos_x: 0.1, pos_y: 0.1, width: 0.5, height: 0.03, value: 'x' },
    ]
    await expect(flattenEsignPdf(src, fields)).rejects.toThrow(/rotated/)
  })
})
