import { describe, it, expect } from 'vitest'
import {
  isValidInboxEmailStagingPath,
  sanitizeAttachmentFilename,
  parseStagedAttachmentInputs,
  MAX_EMAIL_ATTACHMENT_FILES,
} from '@/lib/inbox/email-attachment-staging'

const VALID_PATH = 'inbox-email/123e4567-e89b-42d3-a456-426614174000.pdf'

describe('isValidInboxEmailStagingPath', () => {
  it('accepts the exact server-minted shape', () => {
    expect(isValidInboxEmailStagingPath(VALID_PATH)).toBe(true)
    expect(isValidInboxEmailStagingPath('inbox-email/123E4567-E89B-42D3-A456-426614174000.JPEG')).toBe(true)
  })

  it('rejects everything the server did not mint', () => {
    // Wrong prefix — worker uploads, other buckets' shapes, absolute paths
    expect(isValidInboxEmailStagingPath('worker-chat/123e4567-e89b-42d3-a456-426614174000.pdf')).toBe(false)
    // Path traversal / arbitrary object reads via the service-role client
    expect(isValidInboxEmailStagingPath('inbox-email/../signed-oa/secret.pdf')).toBe(false)
    expect(isValidInboxEmailStagingPath('inbox-email/notauuid.pdf')).toBe(false)
    expect(isValidInboxEmailStagingPath('inbox-email/123e4567-e89b-42d3-a456-426614174000')).toBe(false)
    expect(isValidInboxEmailStagingPath('inbox-email/123e4567-e89b-42d3-a456-426614174000.tar.gz/x')).toBe(false)
    expect(isValidInboxEmailStagingPath('')).toBe(false)
  })
})

describe('sanitizeAttachmentFilename', () => {
  it('passes clean ASCII names through', () => {
    expect(sanitizeAttachmentFilename('invoice-2026.pdf')).toBe('invoice-2026.pdf')
  })

  it('strips header-injection characters (CRLF, quotes, backslash, controls)', () => {
    expect(sanitizeAttachmentFilename('evil"\r\nContent-Type: text/html\r\n.pdf')).toBe(
      'evilContent-Type: text/html.pdf'
    )
    const slashQuote = String.fromCharCode(92) + String.fromCharCode(34) // \ then "
    expect(sanitizeAttachmentFilename(`a${slashQuote}b c.pdf`)).toBe('ab c.pdf')
  })

  it('RFC 2047-encodes non-ASCII names instead of shipping raw bytes', () => {
    const out = sanitizeAttachmentFilename('Contratto società.pdf')
    expect(out.startsWith('=?utf-8?B?')).toBe(true)
    expect(out.endsWith('?=')).toBe(true)
    expect(Buffer.from(out.slice(10, -2), 'base64').toString('utf-8')).toBe('Contratto società.pdf')
  })

  it('never returns an empty name and caps length', () => {
    expect(sanitizeAttachmentFilename('   ')).toBe('attachment')
    expect(sanitizeAttachmentFilename('"\r\n"')).toBe('attachment')
    expect(sanitizeAttachmentFilename('x'.repeat(500)).length).toBeLessThanOrEqual(180)
  })
})

describe('parseStagedAttachmentInputs', () => {
  it('returns null for absent or empty input', () => {
    expect(parseStagedAttachmentInputs(undefined)).toBeNull()
    expect(parseStagedAttachmentInputs(null)).toBeNull()
    expect(parseStagedAttachmentInputs([])).toBeNull()
  })

  it('parses and sanitizes valid entries', () => {
    const out = parseStagedAttachmentInputs([
      { path: VALID_PATH, name: 'file"\r\n.pdf', mime_type: 'application/pdf' },
    ])
    expect(out).toEqual([
      { path: VALID_PATH, name: 'file.pdf', mime_type: 'application/pdf' },
    ])
  })

  it('throws on non-array and on invalid paths', () => {
    expect(() => parseStagedAttachmentInputs('nope')).toThrow()
    expect(() => parseStagedAttachmentInputs([{ path: 'signed-oa/x.pdf', name: 'x.pdf' }])).toThrow()
    expect(() => parseStagedAttachmentInputs([{ name: 'x.pdf' }])).toThrow()
  })

  it('caps the file count', () => {
    const many = Array.from({ length: MAX_EMAIL_ATTACHMENT_FILES + 1 }, () => ({
      path: VALID_PATH,
      name: 'a.pdf',
    }))
    expect(() => parseStagedAttachmentInputs(many)).toThrow(/Too many/)
  })

  it('tolerates a missing mime_type', () => {
    const out = parseStagedAttachmentInputs([{ path: VALID_PATH, name: 'a.pdf' }])
    expect(out?.[0].mime_type).toBeUndefined()
  })
})
