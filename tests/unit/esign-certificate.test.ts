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

  it('handles many signers without throwing (page-overflow guard)', async () => {
    const many: CertificateInfo = {
      ...info,
      signers: Array.from({ length: 20 }, (_, i) => ({ ...info.signers[0], name: `Signer ${i}`, email: `s${i}@x.com` })),
    }
    const pdf = await PDFDocument.create()
    await appendCertificatePage(pdf, many) // must not throw even if content exceeds the page
    expect(pdf.getPageCount()).toBe(1)
  })
})
