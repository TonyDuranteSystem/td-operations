/**
 * A real phone-camera passport photo (18MB PNG, Turcanu/Tacoli passport
 * investigation) exceeded Document AI's ~15MB inline request ceiling and
 * failed outright, with no automatic remedy. ocrDriveFile now shrinks an
 * oversized JPEG/PNG/WEBP before sending it, instead of just failing.
 *
 * Uses a REAL sharp-generated oversized image and REAL sharp compression —
 * not mocked — so the test proves actual bytes actually shrink under the
 * ceiling, not just that a code path was reached. Network is stubbed at
 * global fetch (same pattern as docai-window-read.test.ts), for the same
 * documented reason: a module mocked then dynamically imported more than
 * once only resolves the first time in this repo's vitest setup.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import sharp from 'sharp'
import { DOCAI_INLINE_MAX_BYTES, DOCAI_IMAGE_SHRINK_MAX_BYTES } from '@/lib/docai'

const TOKEN_URI = 'https://oauth2.example.test/token'
const DOCAI_HOST = 'us-documentai.googleapis.com'
const DRIVE_HOST = 'www.googleapis.com'

let oversizedPng: Buffer
let originalSaKey: string | undefined
let servedFile: { bytes: Buffer; mimeType: string }
let receivedByDocai: { bytes: Buffer; mimeType: string } | null

/** Random noise PNG — noise barely compresses, so this reliably exceeds the
 *  inline ceiling without needing an enormous pixel count. */
async function makeOversizedNoisePng(): Promise<Buffer> {
  const width = 3000
  const height = 2500
  const channels = 3
  const raw = Buffer.alloc(width * height * channels)
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256)
  return sharp(raw, { raw: { width, height, channels } }).png({ compressionLevel: 0 }).toBuffer()
}

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  originalSaKey = process.env.GOOGLE_SA_KEY
  process.env.GOOGLE_SA_KEY = Buffer.from(
    JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: pem, token_uri: TOKEN_URI }),
  ).toString('base64')

  oversizedPng = await makeOversizedNoisePng()
}, 30000)

afterAll(() => {
  if (originalSaKey === undefined) delete process.env.GOOGLE_SA_KEY
  else process.env.GOOGLE_SA_KEY = originalSaKey
})

beforeEach(() => {
  receivedByDocai = null

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.startsWith(TOKEN_URI)) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 })
    }

    if (url.includes(DRIVE_HOST) && url.includes('alt=media')) {
      return new Response(new Uint8Array(servedFile.bytes), { status: 200 })
    }

    if (url.includes(DRIVE_HOST) && url.includes('fields=')) {
      return new Response(
        JSON.stringify({ name: 'passport.png', mimeType: servedFile.mimeType, size: String(servedFile.bytes.length) }),
        { status: 200 },
      )
    }

    if (url.includes(DOCAI_HOST)) {
      const body = JSON.parse(String(init?.body)) as { rawDocument: { content: string; mimeType: string } }
      receivedByDocai = {
        bytes: Buffer.from(body.rawDocument.content, 'base64'),
        mimeType: body.rawDocument.mimeType,
      }
      return new Response(
        JSON.stringify({
          document: {
            text: 'PASSPORT\n',
            pages: [{ layout: { textAnchor: { textSegments: [{ startIndex: '0', endIndex: '9' }] }, confidence: 0.95 } }],
          },
        }),
        { status: 200 },
      )
    }

    throw new Error(`unexpected fetch: ${url}`)
  })
})

describe('ocrDriveFile — oversized image shrink', () => {
  it('confirms the test fixture is genuinely over the inline ceiling', () => {
    expect(oversizedPng.length).toBeGreaterThan(DOCAI_INLINE_MAX_BYTES)
  })

  it('shrinks an oversized PNG and sends a JPEG under the ceiling, marking wasShrunk', async () => {
    servedFile = { bytes: oversizedPng, mimeType: 'image/png' }
    const { ocrDriveFile } = await import('@/lib/docai')

    const res = await ocrDriveFile('file-oversized')

    expect(res.wasShrunk).toBe(true)
    expect(res.fullText).toContain('PASSPORT')
    expect(receivedByDocai).not.toBeNull()
    expect(receivedByDocai!.bytes.length).toBeLessThanOrEqual(DOCAI_INLINE_MAX_BYTES)
    expect(receivedByDocai!.mimeType).toBe('image/jpeg')
    // Real JPEG magic bytes (FF D8), not just a size claim.
    expect(receivedByDocai!.bytes[0]).toBe(0xff)
    expect(receivedByDocai!.bytes[1]).toBe(0xd8)
  })

  it('does not touch a normal-sized image — byte-identical to the existing behaviour', async () => {
    const small = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer()
    servedFile = { bytes: small, mimeType: 'image/png' }
    const { ocrDriveFile } = await import('@/lib/docai')

    const res = await ocrDriveFile('file-small')

    expect(res.wasShrunk).toBeUndefined()
    expect(receivedByDocai!.bytes.length).toBe(small.length)
    expect(receivedByDocai!.mimeType).toBe('image/png')
  })

  it('still throws the load-bearing "too large" error for a non-shrinkable format (e.g. TIFF)', async () => {
    // itin/finalize-approval.ts string-matches "too large" on this exact path —
    // an oversized TIFF has no shrink path (SHRINKABLE_IMAGE_MIMES is jpeg/png/webp
    // only) and must keep failing exactly as before.
    servedFile = { bytes: oversizedPng, mimeType: 'image/tiff' }
    const { ocrDriveFile } = await import('@/lib/docai')

    await expect(ocrDriveFile('file-tiff')).rejects.toThrow(/too large for inline processing/)
  })

  it('still throws for an image beyond the shrink ceiling itself', async () => {
    // Simulate a file whose declared size exceeds DOCAI_IMAGE_SHRINK_MAX_BYTES —
    // shrinking a 50MB+ original isn't attempted at all, by design (bounded cost).
    const hugeSize = DOCAI_IMAGE_SHRINK_MAX_BYTES + 1
    servedFile = { bytes: oversizedPng, mimeType: 'image/png' }
    // Override the metadata size the fetch stub reports, independent of the
    // actual fixture bytes (we don't want to generate a real 50MB+ file).
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(TOKEN_URI)) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes(DRIVE_HOST) && url.includes('fields=')) {
        return new Response(
          JSON.stringify({ name: 'passport.png', mimeType: 'image/png', size: String(hugeSize) }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch (should fail before download): ${url}`)
    })
    const { ocrDriveFile } = await import('@/lib/docai')

    await expect(ocrDriveFile('file-huge')).rejects.toThrow(/too large for inline processing/)
  })
})
