import { describe, it, expect, vi } from 'vitest'

// Mock supabaseAdmin / config / action-log so importing the module doesn't pull
// live clients (we only exercise the pure token builder here).
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('@/lib/config', () => ({ APP_BASE_URL: 'https://app.example.com' }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))

import { buildSignatureToken } from '@/lib/operations/signature'

describe('buildSignatureToken', () => {
  it('produces a sig-prefixed, slugified token', () => {
    const t = buildSignatureToken('Acme Holdings LLC', 'Tax Return', 0)
    expect(t.startsWith('sig-acme-holdings-llc-tax-return-')).toBe(true)
  })

  it('strips punctuation and collapses separators', () => {
    const t = buildSignatureToken('  Tony & Sons, Inc.!! ', 'Form 8879 — IRS', 0)
    expect(t).toMatch(/^sig-tony-sons-inc-form-8879-irs-0$/)
  })

  it('encodes the timestamp in base36 for uniqueness', () => {
    const a = buildSignatureToken('Acme', 'Doc', 100)
    const b = buildSignatureToken('Acme', 'Doc', 101)
    expect(a).not.toBe(b)
    expect(a.endsWith(`-${(100).toString(36)}`)).toBe(true)
  })

  it('falls back to safe defaults when names are empty', () => {
    const t = buildSignatureToken('', '', 0)
    expect(t).toBe('sig-company-document-0')
  })

  it('caps the document slug at 30 chars', () => {
    const longDoc = 'a'.repeat(80)
    const t = buildSignatureToken('Co', longDoc, 0)
    // sig-co-<30 a's>-0
    expect(t).toBe(`sig-co-${'a'.repeat(30)}-0`)
  })
})
