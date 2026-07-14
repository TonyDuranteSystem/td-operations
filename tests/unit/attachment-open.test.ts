import { describe, it, expect } from 'vitest'
import {
  resolveAttachmentType,
  shouldOpenInTab,
  MAX_INLINE_BYTES,
} from '@/lib/inbox/attachment-open'

describe('shouldOpenInTab', () => {
  const base = { inline: true, standalone: false, size: 1024 }

  it('views a normal PDF in a tab on desktop', () => {
    expect(shouldOpenInTab(base)).toBe(true)
  })

  // Antonio runs the whole CRM as an installed phone app, where a new tab very
  // often never opens — so we never gamble on window.open there.
  it('ALWAYS downloads in an installed app, even for a viewable type', () => {
    expect(shouldOpenInTab({ ...base, standalone: true })).toBe(false)
  })

  it('downloads anything not safe to render on our origin', () => {
    expect(shouldOpenInTab({ ...base, inline: false })).toBe(false)
  })

  it('downloads a file too large to render in a tab', () => {
    expect(shouldOpenInTab({ ...base, size: MAX_INLINE_BYTES + 1 })).toBe(false)
    expect(shouldOpenInTab({ ...base, size: MAX_INLINE_BYTES })).toBe(true)
  })

  it('treats an unknown size (Gmail reports 0) as fine — it must not block', () => {
    expect(shouldOpenInTab({ ...base, size: 0 })).toBe(true)
  })

  it('download wins whenever ANY reason applies', () => {
    expect(shouldOpenInTab({ inline: false, standalone: true, size: 9e9 })).toBe(false)
  })
})

describe('resolveAttachmentType', () => {
  describe('generic sender types fall back to the filename', () => {
    // The real bug: Alessio Casula's signed PDFs arrived as octet-stream.
    it('treats an octet-stream .pdf as a PDF and opens it inline', () => {
      expect(
        resolveAttachmentType('Diffida_Formale_Ambition_Holding_LLC_signed.pdf', 'application/octet-stream'),
      ).toEqual({ type: 'application/pdf', inline: true })
    })

    it.each([
      '',
      'binary/octet-stream',
      'application/unknown',
      'application/force-download',
    ])('treats %s as generic and uses the extension', (mime) => {
      expect(resolveAttachmentType('report.pdf', mime)).toEqual({
        type: 'application/pdf',
        inline: true,
      })
    })

    it('handles a missing/null sender type', () => {
      expect(resolveAttachmentType('scan.png', null)).toEqual({ type: 'image/png', inline: true })
      expect(resolveAttachmentType('scan.png', undefined)).toEqual({ type: 'image/png', inline: true })
    })

    it('falls back to octet-stream when the extension is unknown', () => {
      expect(resolveAttachmentType('mystery.qqq', 'application/octet-stream')).toEqual({
        type: 'application/octet-stream',
        inline: false,
      })
    })

    it('falls back to octet-stream when there is no extension at all', () => {
      expect(resolveAttachmentType('noextension', 'application/octet-stream')).toEqual({
        type: 'application/octet-stream',
        inline: false,
      })
      expect(resolveAttachmentType('trailingdot.', 'application/octet-stream')).toEqual({
        type: 'application/octet-stream',
        inline: false,
      })
    })

    it('is case-insensitive on the extension', () => {
      expect(resolveAttachmentType('LOUD.PDF', 'APPLICATION/OCTET-STREAM')).toEqual({
        type: 'application/pdf',
        inline: true,
      })
    })
  })

  describe('a real declared type is trusted', () => {
    it('keeps a correctly declared PDF', () => {
      expect(resolveAttachmentType('a.pdf', 'application/pdf')).toEqual({
        type: 'application/pdf',
        inline: true,
      })
    })

    it('strips MIME parameters', () => {
      expect(resolveAttachmentType('notes.txt', 'text/plain; charset=utf-8')).toEqual({
        type: 'text/plain',
        inline: false,
      })
    })

    it('does not let the extension override a real declared type', () => {
      // Sender says PNG, file is named .pdf — trust the declared type.
      expect(resolveAttachmentType('actually-an-image.pdf', 'image/png')).toEqual({
        type: 'image/png',
        inline: true,
      })
    })
  })

  describe('SECURITY: scriptable attachments must never render inline', () => {
    // A blob: URL inherits our origin, so an inline SVG/HTML attachment would
    // execute the sender's script as us. Anyone can email support@.
    it('never opens an SVG inline, even when declared as an image', () => {
      expect(resolveAttachmentType('payload.svg', 'image/svg+xml')).toEqual({
        type: 'image/svg+xml',
        inline: false,
      })
    })

    it('never opens an SVG inline when the type is generic', () => {
      expect(resolveAttachmentType('payload.svg', 'application/octet-stream')).toEqual({
        type: 'image/svg+xml',
        inline: false,
      })
    })

    it.each([
      ['evil.html', 'text/html'],
      ['evil.htm', 'text/html'],
      ['evil.xml', 'application/xml'],
    ])('never opens %s inline', (filename, expectedType) => {
      const r = resolveAttachmentType(filename, 'application/octet-stream')
      expect(r.type).toBe(expectedType)
      expect(r.inline).toBe(false)
    })

    it('never opens a declared text/html inline', () => {
      expect(resolveAttachmentType('page.txt', 'text/html').inline).toBe(false)
    })
  })

  describe('non-viewable formats download rather than open', () => {
    it.each([
      ['archive.zip', 'application/zip'],
      ['contract.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['data.csv', 'text/csv'],
    ])('%s downloads', (filename, expectedType) => {
      const r = resolveAttachmentType(filename, 'application/octet-stream')
      expect(r.type).toBe(expectedType)
      expect(r.inline).toBe(false)
    })
  })

  describe('raster images open inline', () => {
    it.each([
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'],
      ['a.bmp', 'image/bmp'],
    ])('%s opens inline', (filename, expectedType) => {
      expect(resolveAttachmentType(filename, 'application/octet-stream')).toEqual({
        type: expectedType,
        inline: true,
      })
    })
  })
})
