import { describe, it, expect, afterEach } from 'vitest'
import { internalWebhookHeaders, INTERNAL_WEBHOOK_HEADER } from '@/lib/internal-webhook-client'

const ORIGINAL = process.env.NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET
  else process.env.NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET = ORIGINAL
})

describe('internalWebhookHeaders', () => {
  it('returns an empty object when the public secret is unset', () => {
    delete process.env.NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET
    expect(internalWebhookHeaders()).toEqual({})
  })

  it('returns the secret header when configured', () => {
    process.env.NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET = 'abc123'
    expect(internalWebhookHeaders()).toEqual({ [INTERNAL_WEBHOOK_HEADER]: 'abc123' })
  })

  it('uses the canonical header name', () => {
    expect(INTERNAL_WEBHOOK_HEADER).toBe('x-internal-webhook-secret')
  })
})
