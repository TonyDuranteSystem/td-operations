import { describe, it, expect } from 'vitest'
import type { ChatAttachment } from '@/lib/types'

// ── Helpers that mirror the display logic in portal-chat.tsx and contact-detail.tsx ──

function resolveDisplayAttachments(
  attachments: ChatAttachment[] | null | undefined,
  attachment_url: string | null | undefined,
  attachment_name: string | null | undefined,
): ChatAttachment[] {
  if (attachments?.length) return attachments
  if (attachment_url) return [{ url: attachment_url, name: attachment_name || 'Attachment' }]
  return []
}

function isImageUrl(url: string): boolean {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || ''
  return ['jpg','jpeg','png','gif','webp','svg','heic','bmp'].includes(ext)
}

function validateAttachmentUrls(
  attachments: Array<{ url: string }>,
  supabaseBaseUrl: string,
): { valid: boolean; invalidUrl?: string } {
  for (const att of attachments) {
    if (!att.url.startsWith(supabaseBaseUrl)) {
      return { valid: false, invalidUrl: att.url }
    }
  }
  return { valid: true }
}

// ── Tests ──

describe('resolveDisplayAttachments (backward compat)', () => {
  it('returns new attachments array when present and non-empty', () => {
    const atts: ChatAttachment[] = [
      { url: 'https://storage.example.com/a.pdf', name: 'a.pdf' },
      { url: 'https://storage.example.com/b.png', name: 'b.png' },
    ]
    const result = resolveDisplayAttachments(atts, 'https://old.example.com/c.pdf', 'c.pdf')
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('a.pdf')
  })

  it('falls back to legacy attachment_url when attachments is null', () => {
    const result = resolveDisplayAttachments(null, 'https://storage.example.com/c.pdf', 'c.pdf')
    expect(result).toHaveLength(1)
    expect(result[0].url).toBe('https://storage.example.com/c.pdf')
    expect(result[0].name).toBe('c.pdf')
  })

  it('falls back to legacy attachment_url when attachments is empty array', () => {
    const result = resolveDisplayAttachments([], 'https://storage.example.com/c.pdf', 'c.pdf')
    expect(result).toHaveLength(1)
    expect(result[0].url).toBe('https://storage.example.com/c.pdf')
  })

  it('uses "Attachment" as fallback name when attachment_name is null', () => {
    const result = resolveDisplayAttachments(null, 'https://storage.example.com/c.pdf', null)
    expect(result[0].name).toBe('Attachment')
  })

  it('returns empty array when both attachments and attachment_url are absent', () => {
    const result = resolveDisplayAttachments(null, null, null)
    expect(result).toHaveLength(0)
  })

  it('renders 3 attachments from new column correctly', () => {
    const atts: ChatAttachment[] = [
      { url: 'https://s.co/1.pdf', name: 'doc1.pdf', size: 1024 },
      { url: 'https://s.co/2.png', name: 'img.png', mime_type: 'image/png' },
      { url: 'https://s.co/3.xlsx', name: 'sheet.xlsx', size: 2048 },
    ]
    const result = resolveDisplayAttachments(atts, null, null)
    expect(result).toHaveLength(3)
    expect(result[2].name).toBe('sheet.xlsx')
  })
})

describe('isImageUrl', () => {
  it('detects jpg as image', () => { expect(isImageUrl('https://s.co/file.jpg')).toBe(true) })
  it('detects png as image', () => { expect(isImageUrl('https://s.co/file.png')).toBe(true) })
  it('detects gif as image', () => { expect(isImageUrl('https://s.co/file.gif')).toBe(true) })
  it('detects webp as image', () => { expect(isImageUrl('https://s.co/file.webp')).toBe(true) })
  it('treats pdf as non-image', () => { expect(isImageUrl('https://s.co/file.pdf')).toBe(false) })
  it('treats docx as non-image', () => { expect(isImageUrl('https://s.co/file.docx')).toBe(false) })
  it('ignores query strings', () => { expect(isImageUrl('https://s.co/file.png?token=abc')).toBe(true) })
})

describe('validateAttachmentUrls (security)', () => {
  const SUPABASE_URL = 'https://xjcxlmlpeywtwkhstjlw.supabase.co'

  it('accepts valid Supabase storage URLs', () => {
    const atts = [
      { url: `${SUPABASE_URL}/storage/v1/object/public/assets/chat-attachments/a.pdf` },
      { url: `${SUPABASE_URL}/storage/v1/object/public/assets/chat-attachments/b.png` },
    ]
    const result = validateAttachmentUrls(atts, SUPABASE_URL)
    expect(result.valid).toBe(true)
  })

  it('rejects URLs from external domains', () => {
    const atts = [
      { url: `${SUPABASE_URL}/storage/v1/object/public/assets/a.pdf` },
      { url: 'https://evil.example.com/malware.exe' },
    ]
    const result = validateAttachmentUrls(atts, SUPABASE_URL)
    expect(result.valid).toBe(false)
    expect(result.invalidUrl).toBe('https://evil.example.com/malware.exe')
  })

  it('rejects empty URL', () => {
    const atts = [{ url: '' }]
    const result = validateAttachmentUrls(atts, SUPABASE_URL)
    expect(result.valid).toBe(false)
  })

  it('accepts an empty attachments array', () => {
    const result = validateAttachmentUrls([], SUPABASE_URL)
    expect(result.valid).toBe(true)
  })
})

describe('message validity logic', () => {
  function isValidMessage(message: string | undefined, attachments: ChatAttachment[]): boolean {
    return !!(message?.trim()) || attachments.length > 0
  }

  it('message text alone is valid', () => {
    expect(isValidMessage('Hello', [])).toBe(true)
  })

  it('attachments alone (no text) is valid', () => {
    expect(isValidMessage('', [{ url: 'https://s.co/a.pdf', name: 'a.pdf' }])).toBe(true)
    expect(isValidMessage(undefined, [{ url: 'https://s.co/a.pdf', name: 'a.pdf' }])).toBe(true)
  })

  it('empty text with no attachments is invalid', () => {
    expect(isValidMessage('', [])).toBe(false)
    expect(isValidMessage('   ', [])).toBe(false)
    expect(isValidMessage(undefined, [])).toBe(false)
  })

  it('text + attachments together is valid', () => {
    expect(isValidMessage('See attached', [{ url: 'https://s.co/a.pdf', name: 'a.pdf' }])).toBe(true)
  })
})
