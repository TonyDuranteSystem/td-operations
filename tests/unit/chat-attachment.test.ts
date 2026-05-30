import { describe, it, expect } from 'vitest'
import {
  validateChatAttachment,
  getExtension,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_MB,
} from '@/lib/portal/chat-attachment'

describe('getExtension', () => {
  it('returns lower-cased extension', () => {
    expect(getExtension('Passport.JPG')).toBe('jpg')
    expect(getExtension('scan.PDF')).toBe('pdf')
  })
  it('handles multiple dots', () => {
    expect(getExtension('my.passport.final.png')).toBe('png')
  })
  it('strips punctuation', () => {
    expect(getExtension('file.jpeg?v=2')).toBe('jpegv2') // query only matters for URLs; raw name sanitized
  })
  it('returns empty string when no extension', () => {
    expect(getExtension('passport')).toBe('')
    expect(getExtension('')).toBe('')
  })
})

describe('validateChatAttachment — size', () => {
  it('accepts a normal passport photo (6MB)', () => {
    expect(validateChatAttachment('passport.jpg', 6 * 1024 * 1024, 'image/jpeg')).toBeNull()
  })
  it('accepts a large PDF scan (50MB)', () => {
    expect(validateChatAttachment('scan.pdf', 50 * 1024 * 1024, 'application/pdf')).toBeNull()
  })
  it('accepts exactly at the cap', () => {
    expect(validateChatAttachment('big.pdf', CHAT_ATTACHMENT_MAX_BYTES, 'application/pdf')).toBeNull()
  })
  it('rejects just over the cap with a specific message', () => {
    const err = validateChatAttachment('huge.pdf', CHAT_ATTACHMENT_MAX_BYTES + 1, 'application/pdf')
    expect(err).not.toBeNull()
    expect(err).toContain(`${CHAT_ATTACHMENT_MAX_MB} MB`)
  })
})

describe('validateChatAttachment — type policy (allow normal, block active content)', () => {
  it('accepts iPhone HEIC photos', () => {
    expect(validateChatAttachment('IMG_1234.heic', 4 * 1024 * 1024, 'image/heic')).toBeNull()
  })
  it('accepts common documents and media', () => {
    for (const [name, mime] of [
      ['photo.png', 'image/png'],
      ['photo.webp', 'image/webp'],
      ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['notes.txt', 'text/plain'],
      ['archive.zip', 'application/zip'],
      ['clip.mp4', 'video/mp4'],
      ['voice.m4a', 'audio/mp4'],
    ] as const) {
      expect(validateChatAttachment(name, 1024, mime), `${name} should be allowed`).toBeNull()
    }
  })

  it('blocks HTML by extension and by mime', () => {
    expect(validateChatAttachment('page.html', 1024, 'text/html')).not.toBeNull()
    expect(validateChatAttachment('page', 1024, 'text/html')).not.toBeNull()
    expect(validateChatAttachment('page.html', 1024, '')).not.toBeNull()
  })
  it('blocks SVG (active content) ', () => {
    expect(validateChatAttachment('logo.svg', 1024, 'image/svg+xml')).not.toBeNull()
  })
  it('blocks scripts and executables', () => {
    for (const [name, mime] of [
      ['evil.js', 'text/javascript'],
      ['evil.mjs', ''],
      ['run.sh', 'application/x-sh'],
      ['setup.exe', 'application/x-msdownload'],
      ['installer.msi', ''],
      ['app.jar', 'application/java-archive'],
      ['shell.bat', ''],
      ['x.php', 'application/x-httpd-php'],
    ] as const) {
      expect(validateChatAttachment(name, 1024, mime), `${name} should be blocked`).not.toBeNull()
    }
  })
  it('blocks even when mime is benign but extension is dangerous', () => {
    // A .exe mislabeled as octet-stream is still blocked by extension.
    expect(validateChatAttachment('payload.exe', 1024, 'application/octet-stream')).not.toBeNull()
  })
  it('handles mime with charset parameter', () => {
    expect(validateChatAttachment('p.html', 1024, 'text/html; charset=utf-8')).not.toBeNull()
  })
})
