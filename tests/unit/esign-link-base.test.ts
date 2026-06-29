import { describe, it, expect } from 'vitest'
import { chooseLinkBase, originFromHeaders } from '@/lib/esign/link-base'
import { APP_BASE_URL } from '@/lib/config'

describe('chooseLinkBase', () => {
  it('uses the stable public domain in production (never the request host)', () => {
    expect(chooseLinkBase('https://td-operations.vercel.app', true)).toBe(APP_BASE_URL)
    expect(chooseLinkBase(null, true)).toBe(APP_BASE_URL)
  })
  it('uses the request origin on preview/sandbox so QA links open', () => {
    expect(chooseLinkBase('https://td-operations-sandbox-abc.vercel.app', false)).toBe('https://td-operations-sandbox-abc.vercel.app')
  })
  it('falls back to APP_BASE_URL when no origin is available', () => {
    expect(chooseLinkBase(null, false)).toBe(APP_BASE_URL)
    expect(chooseLinkBase('', false)).toBe(APP_BASE_URL)
  })
})

describe('originFromHeaders', () => {
  it('prefers x-forwarded-host + proto', () => {
    const get = (n: string) => ({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'preview.vercel.app' }[n] ?? null)
    expect(originFromHeaders(get)).toBe('https://preview.vercel.app')
  })
  it('falls back to host and defaults proto to https', () => {
    const get = (n: string) => ({ host: 'localhost:3000' }[n] ?? null)
    expect(originFromHeaders(get)).toBe('https://localhost:3000')
  })
  it('returns null with no host', () => {
    expect(originFromHeaders(() => null)).toBeNull()
  })
})
