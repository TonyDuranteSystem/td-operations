import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { hasPdfMagic, validatePdfUpload, scanForMalware } from '@/lib/esign/upload-guard'

async function makePdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([612, 792])
  return await doc.save()
}

describe('hasPdfMagic', () => {
  it('accepts %PDF- and rejects other signatures', () => {
    expect(hasPdfMagic(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true)
    expect(hasPdfMagic(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBe(false) // MZ (exe)
    expect(hasPdfMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(false) // PK (zip/docx)
    expect(hasPdfMagic(new Uint8Array([0x25]))).toBe(false) // too short
  })
})

describe('validatePdfUpload', () => {
  it('accepts a real one-page PDF', async () => {
    const res = await validatePdfUpload(await makePdf(1))
    expect(res.ok).toBe(true)
    expect(res.pageCount).toBe(1)
  })

  it('rejects an empty file', async () => {
    const res = await validatePdfUpload(new Uint8Array())
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/empty/i)
  })

  it('rejects a non-PDF renamed as .pdf (magic-byte check)', async () => {
    const fakeExe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
    const res = await validatePdfUpload(fakeExe)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not a valid PDF/i)
  })

  it('rejects an over-size file', async () => {
    const pdf = await makePdf(1)
    const res = await validatePdfUpload(pdf, { maxBytes: 10 })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/limit is/i)
  })

  it('rejects too many pages', async () => {
    const res = await validatePdfUpload(await makePdf(3), { maxPages: 2 })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/3 pages/)
  })

  it('rejects unreadable bytes that pass the magic check', async () => {
    const junk = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x01, 0x02, 0x03])
    const res = await validatePdfUpload(junk)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not be read/i)
  })
})

describe('scanForMalware (seam)', () => {
  it('returns clean by default', async () => {
    expect(await scanForMalware(new Uint8Array([1, 2, 3]))).toEqual({ clean: true })
  })
})
