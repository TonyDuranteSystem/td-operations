/**
 * GROUND TRUTH for windowed OCR reads.
 *
 * The failure this suite exists to make impossible: returning the WRONG pages
 * while reporting success. A test that only asserts "text came back" passes
 * happily when window 16-30 is silently served as pages 1-15 — which is exactly
 * the defect three independent reviewers found in the draft design.
 *
 * How we get a real oracle without Drive or Google: each page of the synthetic
 * source PDF is given a UNIQUE WIDTH (page n is 100+n wide). The fake Document
 * AI endpoint decodes the PDF it actually received and reports those widths back
 * as page text. So an assertion on the returned text is an assertion about which
 * physical pages were put in the envelope — font-free, deterministic, and
 * impossible to satisfy by accident.
 *
 * Network is stubbed at GLOBAL FETCH, not by mocking the module. That is
 * deliberate: this repo has a documented vitest quirk where a module mocked and
 * then dynamically imported more than once only resolves the first time, which
 * would silently skip most of the cases below.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { absolutePageToWindowIndex } from '@/lib/docai-windows'

const TOKEN_URI = 'https://oauth2.example.test/token'
const DOCAI_HOST = 'us-documentai.googleapis.com'
const DRIVE_HOST = 'www.googleapis.com'

let sourcePdf: Buffer
let docaiCalls: number
let lastWindowWidths: number[]
let originalSaKey: string | undefined

/** A PDF whose page n is uniquely identifiable by its width (100+n). */
async function makeWidthStampedPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let n = 1; n <= pageCount; n++) doc.addPage([100 + n, 200])
  return Buffer.from(await doc.save())
}

/** Decode what was actually sent to Document AI and read back its page widths. */
async function widthsOf(pdfBytes: Buffer): Promise<number[]> {
  const doc = await PDFDocument.load(pdfBytes)
  return doc.getPages().map((p) => Math.round(p.getWidth()))
}

beforeAll(async () => {
  // A real RSA key — lib/docai signs a JWT with importPKCS8, which rejects junk.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  originalSaKey = process.env.GOOGLE_SA_KEY
  process.env.GOOGLE_SA_KEY = Buffer.from(
    JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: pem, token_uri: TOKEN_URI }),
  ).toString('base64')

  sourcePdf = await makeWidthStampedPdf(35)
})

afterAll(() => {
  if (originalSaKey === undefined) delete process.env.GOOGLE_SA_KEY
  else process.env.GOOGLE_SA_KEY = originalSaKey
})

beforeEach(() => {
  docaiCalls = 0
  lastWindowWidths = []

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.startsWith(TOKEN_URI)) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 })
    }

    if (url.includes(DRIVE_HOST) && url.includes('alt=media')) {
      return new Response(new Uint8Array(sourcePdf), { status: 200 })
    }

    if (url.includes(DRIVE_HOST) && url.includes('fields=')) {
      return new Response(
        JSON.stringify({ name: '2023 Return.pdf', mimeType: 'application/pdf', size: String(sourcePdf.length) }),
        { status: 200 },
      )
    }

    if (url.includes(DOCAI_HOST)) {
      docaiCalls++
      const body = JSON.parse(String(init?.body)) as { rawDocument: { content: string } }
      const received = Buffer.from(body.rawDocument.content, 'base64')
      lastWindowWidths = await widthsOf(received)

      // Report each received page's width as its text, with correct anchors.
      let text = ''
      const pages = lastWindowWidths.map((w) => {
        const chunk = `W${w}\n`
        const start = text.length
        text += chunk
        return {
          layout: {
            textAnchor: { textSegments: [{ startIndex: String(start), endIndex: String(start + chunk.length) }] },
            confidence: 0.9,
          },
        }
      })
      return new Response(JSON.stringify({ document: { text, pages } }), { status: 200 })
    }

    throw new Error(`unexpected fetch: ${url}`)
  })
})

describe('windowed OCR returns the RIGHT pages', () => {
  it('a middle window sends exactly those absolute pages — not the first ones', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const res = await ocrDriveFile('file-1', { pages: [16, 30] })

    // The oracle: physical pages 16..30 are what got sent.
    expect(lastWindowWidths).toEqual(Array.from({ length: 15 }, (_, i) => 116 + i))
    // The negative assertion is what kills the off-by-window bug.
    expect(lastWindowWidths).not.toContain(101)
    expect(res.pages).toHaveLength(15)
    expect(res.pages[0]).toContain('W116')
    expect(res.pages[14]).toContain('W130')
  })

  it('reports the TRUE document length, not the window length', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const res = await ocrDriveFile('file-1', { pages: [16, 30] })
    expect(res.documentPageCount).toBe(35)
    expect(res.pageCount).toBe(15) // pages OCR'd
    expect(res.windowStart).toBe(16)
  })

  it('a single page sends ONE page and OCRs nothing else', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const res = await ocrDriveFile('file-1', { pages: [20, 20] })
    expect(lastWindowWidths).toEqual([120])
    expect(res.pages[0]).toContain('W120')
    // Proves it isn't OCR-ing the whole document and then slicing.
    expect(docaiCalls).toBe(1)
  })

  it('absolute page numbers resolve through the window helper end-to-end', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const res = await ocrDriveFile('file-1', { pages: [16, 30] })
    const idx = absolutePageToWindowIndex(20, [res.windowStart!, res.windowStart! + res.pages.length - 1])
    expect(idx).toBe(4)
    expect(res.pages[idx!]).toContain('W120') // page 20 really is page 20
  })

  it('CONSERVATION: successive windows cover all 35 pages exactly once, in order', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const seen: number[] = []
    for (const start of [1, 16, 31]) {
      const res = await ocrDriveFile('file-1', { pages: [start, start + 14] })
      seen.push(...lastWindowWidths)
      expect(res.documentPageCount).toBe(35)
    }
    expect(seen).toEqual(Array.from({ length: 35 }, (_, i) => 101 + i))
    expect(new Set(seen).size).toBe(35) // no duplicates
  })

  it('BOUNDARY: pages 15 and 16 land in different windows and keep their identity', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    await ocrDriveFile('file-1', { pages: [1, 15] })
    expect(lastWindowWidths.at(-1)).toBe(115)
    await ocrDriveFile('file-1', { pages: [16, 30] })
    expect(lastWindowWidths[0]).toBe(116)
  })

  it('a range wider than the limit is clamped to one window, never silently merged', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    await ocrDriveFile('file-1', { pages: [1, 35] })
    expect(lastWindowWidths).toHaveLength(15)
    expect(docaiCalls).toBe(1)
  })

  it('the tail window is short, not padded, and stops at the last real page', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const res = await ocrDriveFile('file-1', { pages: [31, 45] })
    expect(lastWindowWidths).toEqual([131, 132, 133, 134, 135])
    expect(res.documentPageCount).toBe(35)
  })

  it('a start past the end of the document OCRs nothing at all', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const res = await ocrDriveFile('file-1', { pages: [40, 45] })
    expect(res.pages).toEqual([])
    expect(res.documentPageCount).toBe(35)
    expect(docaiCalls).toBe(0) // never bill for a window that cannot exist
  })

  it('an UNWINDOWED read still sends the whole file, exactly as before', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    const res = await ocrDriveFile('file-1')
    expect(lastWindowWidths).toHaveLength(35) // whole document, one call
    expect(docaiCalls).toBe(1)
    expect(res.pageCount).toBe(35)
  })
})

describe('negative control — the suite can actually fail', () => {
  it('a wrong-window read would be caught by the identity assertion', async () => {
    const { ocrDriveFile } = await import('@/lib/docai')
    await ocrDriveFile('file-1', { pages: [16, 30] })
    // If windowing regressed to "always the first window", widths would start at
    // 101. Assert the distinction explicitly so the guarantee is visible here.
    expect(lastWindowWidths[0]).not.toBe(101)
    expect(lastWindowWidths[0]).toBe(116)
  })
})
