import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { fitFieldText } from '@/lib/pdf/fit-field'

async function formWithField(width: number) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 200])
  const form = doc.getForm()
  const field = form.createTextField('name')
  field.addToPage(page, { x: 10, y: 100, width, height: 14 })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  return { form, font }
}

describe('fitFieldText — the text shrinks to the box instead of being cut off', () => {
  it('a long line in a narrow box gets a smaller font, never below the minimum', async () => {
    const { form, font } = await formWithField(184)
    const text = 'Antonio Noel Durante, Certified Acceptance Agent'
    const size = fitFieldText(form, 'name', text, font)
    expect(size).not.toBeNull()
    expect(size!).toBeLessThan(10)
    expect(size!).toBeGreaterThanOrEqual(5.5)
    expect(font.widthOfTextAtSize(text, size!)).toBeLessThanOrEqual(184)
  })

  it('a short line keeps the normal size', async () => {
    const { form, font } = await formWithField(184)
    expect(fitFieldText(form, 'name', 'Tony Durante LLC', font)).toBe(10)
  })

  it('an unknown field never throws (returns null)', async () => {
    const { form, font } = await formWithField(100)
    expect(fitFieldText(form, 'does-not-exist', 'x', font)).toBeNull()
  })
})
