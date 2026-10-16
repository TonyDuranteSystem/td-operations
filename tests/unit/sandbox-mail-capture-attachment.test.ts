import { describe, it, expect } from 'vitest'
import { createRawEmail } from '@/lib/portal/invoice-email'
import { decodeSandboxEmail } from '@/lib/sandbox-mail-capture'

describe('sandbox mail capture with a PDF attachment', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2, 255, 254, 0, 0, 200]), Buffer.from('x'.repeat(2000))])
  const raw = createRawEmail({
    from: 'Acme <invoices@tdinvoice.com>', to: 'buyer@example.com', subject: 'Invoice INV-1 from Acme',
    html: '<p>Hello <a href="https://portal.example.com/pay?a=1&amp;b=2">pay</a></p>', replyTo: 'acme@example.com',
    attachment: { base64: pdf.toString('base64'), filename: 'INV-1.pdf' },
  })

  it('keeps the readable body and never stores NUL characters', () => {
    const d = decodeSandboxEmail(raw)
    expect(d.recipient).toBe('buyer@example.com')
    expect(d.subject).toBe('Invoice INV-1 from Acme')
    expect(d.body).toContain('Hello')
    expect(d.body).not.toContain('\u0000')
    expect(d.body).not.toContain('%PDF')
  })

  it('names the attachment instead of decoding it', () => {
    expect(decodeSandboxEmail(raw).body).toContain('[Attachment: INV-1.pdf]')
  })
})
