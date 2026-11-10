/**
 * Scan document: hold-steady rules, the three looks, the PDF, and the rules of one scan
 * (lib/scan/steady, enhance, pdf, session).
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createSteadyTracker } from '@/lib/scan/steady'
import { applyLook, DEFAULT_SCAN_LOOK, levelsOf, paperBrightness, SCAN_LOOKS } from '@/lib/scan/enhance'
import { buildPdf, pdfPageSize } from '@/lib/scan/pdf'
import { MAX_SCAN_PAGES, canAddPage, cleanScanName, defaultScanName, movePage, removePage, scanFileName } from '@/lib/scan/session'
import type { Point, Quad, Raster } from '@/lib/scan/geometry'

const P = (x: number, y: number): Point => ({ x, y })
const quad = (dx = 0): Quad => [P(10 + dx, 10), P(90 + dx, 10), P(90 + dx, 120), P(10 + dx, 120)]

describe('createSteadyTracker', () => {
  it('turns steady after the outline holds still for enough looks, with a growing ring', () => {
    const t = createSteadyTracker({ needed: 4 })
    expect(t.push(quad(), 100, 130)).toEqual({ steady: false, progress: 0.25 })
    expect(t.push(quad(0.5), 100, 130).progress).toBe(0.5)
    expect(t.push(quad(), 100, 130).progress).toBe(0.75)
    expect(t.push(quad(), 100, 130)).toEqual({ steady: true, progress: 1 })
  })

  it('starts again when the page moves more than the tolerance', () => {
    const t = createSteadyTracker({ needed: 3, tolerance: 0.02 })
    t.push(quad(), 100, 130); t.push(quad(), 100, 130)
    expect(t.push(quad(20), 100, 130)).toEqual({ steady: false, progress: 1 / 3 })
  })

  it('starts again when the page is lost, and reset() clears it', () => {
    const t = createSteadyTracker({ needed: 2 })
    t.push(quad(), 100, 130)
    expect(t.push(null, 100, 130)).toEqual({ steady: false, progress: 0 })
    expect(t.push(quad(), 100, 130).progress).toBe(0.5)
    t.reset()
    expect(t.push(quad(), 100, 130).progress).toBe(0.5)
  })
})

/** a 100x100 "page": paper of brightness `paper`, dark writing stripes, lit unevenly from left to right */
function page(paper: number, shade = 0): Raster {
  const w = 100, h = 100
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const light = 1 - shade * (x / w)
    const ink = y % 10 < 2 && x > 10 && x < 90
    const v = (ink ? paper * 0.25 : paper) * light
    const i = (y * w + x) * 4
    data[i] = v; data[i + 1] = v; data[i + 2] = v * 0.9; data[i + 3] = 255
  }
  return { data, width: w, height: h }
}
const px = (r: Raster, x: number, y: number) => r.data[(y * r.width + x) * 4]

describe('looks', () => {
  it('colour comes first', () => {
    expect(DEFAULT_SCAN_LOOK).toBe('colour')
    expect(SCAN_LOOKS).toEqual(['colour', 'document', 'grey'])
  })

  it('document: clean white paper and dark writing even when one side is in shadow', () => {
    const out = applyLook(page(210, 0.45), 'document')
    // paper on the dark side and on the bright side are both near white
    expect(px(out, 8, 5)).toBeGreaterThan(235)
    expect(px(out, 95, 5)).toBeGreaterThan(235)
    // the writing stays dark on both sides
    expect(px(out, 30, 0)).toBeLessThan(60)
    expect(px(out, 80, 0)).toBeLessThan(60)
    // and it is black and white only
    const i = (5 * 100 + 50) * 4
    expect(out.data[i]).toBe(out.data[i + 1]); expect(out.data[i]).toBe(out.data[i + 2])
  })

  it('grey: no colour left, brightness stretched to the full range', () => {
    const out = applyLook(page(180), 'grey')
    const i = (5 * 100 + 50) * 4
    expect(out.data[i]).toBe(out.data[i + 1]); expect(out.data[i]).toBe(out.data[i + 2])
    expect(px(out, 50, 5)).toBeGreaterThan(240)
    expect(px(out, 30, 0)).toBeLessThan(40)
  })

  it('colour: keeps the colours (a blue-ish picture stays blue-ish) and brightens', () => {
    const w = 20, h = 20, data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) { const dark = i % 7 === 0; data[i * 4] = dark ? 20 : 150; data[i * 4 + 1] = dark ? 20 : 170; data[i * 4 + 2] = dark ? 40 : 200; data[i * 4 + 3] = 255 }
    const out = applyLook({ data, width: w, height: h }, 'colour')
    const k = 1 * 4 // pixel 1 is a light one
    expect(out.data[k + 2]).toBeGreaterThan(out.data[k]) // still bluer than red
    expect(out.data[k + 2]).toBeGreaterThan(200) // brighter than before (200)
  })

  it('never changes the size, always opaque, and does not touch the original', () => {
    const src = page(200)
    const before = src.data.slice()
    for (const look of SCAN_LOOKS) {
      const out = applyLook(src, look)
      expect(out.width).toBe(100); expect(out.height).toBe(100)
      expect(out.data[3]).toBe(255)
    }
    expect(Array.from(src.data)).toEqual(Array.from(before))
  })

  it('levelsOf copes with a flat picture; paperBrightness follows the lighting', () => {
    const flat = new Uint8ClampedArray(100).fill(128)
    const { lo, hi } = levelsOf(flat)
    expect(hi - lo).toBeGreaterThanOrEqual(40)
    const lit = page(200, 0.5)
    const luma = new Uint8ClampedArray(100 * 100)
    for (let i = 0; i < luma.length; i++) luma[i] = lit.data[i * 4]
    const paper = paperBrightness(luma, 100, 100)
    expect(paper[5 * 100 + 5]).toBeGreaterThan(paper[5 * 100 + 95] + 30) // brighter on the lit side
  })
})

describe('pdf', () => {
  it('sizes a page to the picture\'s own shape, long side an A4 long side', () => {
    const a4 = pdfPageSize(1000, 1414.21)
    expect(a4.width).toBeCloseTo(595.28, 1); expect(a4.height).toBe(841.89)
    const land = pdfPageSize(2000, 1000)
    expect(land.width).toBe(841.89); expect(land.height).toBeCloseTo(420.95, 1)
  })

  it('makes one PDF with one page per picture, in order', async () => {
    const jpeg = async (w: number, h: number) => new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: '#cccccc' } }).jpeg().toBuffer())
    const bytes = await buildPdf([
      { jpeg: await jpeg(30, 40), width: 30, height: 40 },
      { jpeg: await jpeg(60, 40), width: 60, height: 40 },
      { jpeg: await jpeg(30, 40), width: 30, height: 40 },
    ])
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(3)
    expect(doc.getPage(1).getWidth()).toBeGreaterThan(doc.getPage(1).getHeight()) // the wide picture is a landscape page
    expect(doc.getPage(0).getWidth()).toBeLessThan(doc.getPage(0).getHeight())
  })

  it('refuses an empty scan', async () => {
    await expect(buildPdf([])).rejects.toThrow()
  })
})

describe('scan rules', () => {
  it('names a scan after today, to the minute, with no colon', () => {
    expect(defaultScanName(new Date(2026, 10, 10, 14, 32))).toBe('Scan 2026-11-10 14.32')
    expect(defaultScanName(new Date(2026, 0, 5, 9, 5))).toBe('Scan 2026-01-05 09.05')
  })

  it('cleans what was typed into a safe file name', () => {
    const fb = 'Scan 2026-11-10 14.32'
    expect(cleanScanName('  Passport  Anna  ', fb)).toBe('Passport Anna')
    expect(cleanScanName('a/b\\c:d*e?f"g<h>i|j', fb)).toBe('a b c d e f g h i j')
    expect(cleanScanName('Contract.pdf', fb)).toBe('Contract')
    expect(cleanScanName('Contract.PDF.pdf', fb)).toBe('Contract')
    expect(cleanScanName('../../etc/passwd', fb)).toBe('etc passwd')
    expect(cleanScanName('   ', fb)).toBe(fb)
    expect(cleanScanName('.pdf', fb)).toBe(fb)
    expect(cleanScanName('x'.repeat(200), fb).length).toBe(80)
    expect(scanFileName('Passport Anna')).toBe('Passport Anna.pdf')
  })

  it('stops at 20 pages', () => {
    expect(MAX_SCAN_PAGES).toBe(20)
    expect(canAddPage(19)).toBe(true)
    expect(canAddPage(20)).toBe(false)
  })

  it('moves and removes pages without touching the original list', () => {
    const list = ['a', 'b', 'c', 'd']
    expect(movePage(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(movePage(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(movePage(list, 1, 1)).toEqual(list)
    expect(movePage(list, 9, 0)).toEqual(list)
    expect(removePage(list, 1)).toEqual(['a', 'c', 'd'])
    expect(removePage(list, 7)).toEqual(list)
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })
})
