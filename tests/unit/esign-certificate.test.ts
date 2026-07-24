import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { wrapText, appendCertificatePage, type CertificateInfo } from '@/lib/esign/certificate'

describe('wrapText', () => {
  it('wraps to the char budget without splitting words', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 12)
    expect(lines.every(l => l.length <= 12)).toBe(true)
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog')
  })
  it('returns [""] for empty input', () => {
    expect(wrapText('', 10)).toEqual([''])
  })
  it('hard-splits a single word longer than the budget (no overflow)', () => {
    const long = 'x'.repeat(300)
    const lines = wrapText(long, 40)
    expect(lines.every(l => l.length <= 40)).toBe(true) // never exceeds the budget
    expect(lines.join('')).toBe(long)                   // lossless
    expect(lines.length).toBe(Math.ceil(300 / 40))
  })
  it('hard-splits a long token mixed with normal words', () => {
    const lines = wrapText('hi ' + 'a'.repeat(25) + ' bye', 10)
    expect(lines.every(l => l.length <= 10)).toBe(true)
    expect(lines.join(' ').replace(/\s+/g, '')).toContain('a'.repeat(25))
  })
})

describe('appendCertificatePage', () => {
  const info: CertificateInfo = {
    envelopeId: 'env-123',
    documentName: 'Engagement Letter',
    documentSha256: 'a'.repeat(64),
    completedAt: '2026-06-27T16:05:26.909Z',
    consentText: 'I agree to sign electronically (ESIGN/UETA) and that my electronic signature is legally binding.',
    signers: [
      // UNICODE: accented name + € must not crash (the Helvetica trap).
      { name: 'José Núñez', email: 'jose@example.com', signedByName: 'José Núñez', signedAt: '2026-06-27T16:05:26Z', ip: '108.191.106.53', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', consent: true, signatureHash: 'b'.repeat(64) },
    ],
  }

  it('appends exactly one page and stays a valid PDF', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([612, 792]) // the "signed" page
    await appendCertificatePage(pdf, info)
    expect(pdf.getPageCount()).toBe(2)
    const bytes = await pdf.save()
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(2)
  })

  it('spills onto more pages for many signers instead of dropping them', async () => {
    // This used to assert exactly 1 page — pinning the old behaviour, where the
    // draw helper simply RETURNED at the page bottom. That silently dropped the
    // later signers' IP / consent / signature-hash rows AND the closing consent
    // statement off the end of the Certificate of Completion, while the
    // certificate still looked complete. For a legal artifact, losing a signer's
    // audit trail is worse than a longer document: it must paginate, not truncate.
    const many: CertificateInfo = {
      ...info,
      signers: Array.from({ length: 20 }, (_, i) => ({ ...info.signers[0], name: `Signer ${i}`, email: `s${i}@x.com` })),
    }
    const pdf = await PDFDocument.create()
    await appendCertificatePage(pdf, many)
    expect(pdf.getPageCount()).toBeGreaterThan(1)
    // Still a valid, reloadable PDF once paginated.
    const reloaded = await PDFDocument.load(await pdf.save())
    expect(reloaded.getPageCount()).toBe(pdf.getPageCount())
  })

  it('keeps a single-signer certificate to one page (no gratuitous pagination)', async () => {
    const pdf = await PDFDocument.create()
    await appendCertificatePage(pdf, info)
    expect(pdf.getPageCount()).toBe(1)
  })
})
