import { describe, it, expect, afterEach } from 'vitest'
import { verifyInternalWebhookSecret, INTERNAL_WEBHOOK_HEADER } from '@/lib/webhook-internal-auth'

function reqWith(headerValue: string | null) {
  return {
    headers: {
      get(name: string) {
        return name.toLowerCase() === INTERNAL_WEBHOOK_HEADER ? headerValue : null
      },
    },
  }
}

const ORIGINAL = process.env.INTERNAL_WEBHOOK_SECRET

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INTERNAL_WEBHOOK_SECRET
  else process.env.INTERNAL_WEBHOOK_SECRET = ORIGINAL
})

describe('verifyInternalWebhookSecret', () => {
  it('fails closed when the secret env var is unset', () => {
    delete process.env.INTERNAL_WEBHOOK_SECRET
    expect(verifyInternalWebhookSecret(reqWith('anything'))).toBe(false)
  })

  it('fails closed when the secret env var is empty', () => {
    process.env.INTERNAL_WEBHOOK_SECRET = '   '
    expect(verifyInternalWebhookSecret(reqWith('anything'))).toBe(false)
  })

  it('rejects a request with no header', () => {
    process.env.INTERNAL_WEBHOOK_SECRET = 'topsecret'
    expect(verifyInternalWebhookSecret(reqWith(null))).toBe(false)
  })

  it('rejects a wrong secret', () => {
    process.env.INTERNAL_WEBHOOK_SECRET = 'topsecret'
    expect(verifyInternalWebhookSecret(reqWith('nope'))).toBe(false)
  })

  it('accepts the correct secret', () => {
    process.env.INTERNAL_WEBHOOK_SECRET = 'topsecret'
    expect(verifyInternalWebhookSecret(reqWith('topsecret'))).toBe(true)
  })

  it('trims surrounding whitespace on the provided header', () => {
    process.env.INTERNAL_WEBHOOK_SECRET = 'topsecret'
    expect(verifyInternalWebhookSecret(reqWith('  topsecret  '))).toBe(true)
  })
})
