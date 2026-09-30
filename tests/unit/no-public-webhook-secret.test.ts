/**
 * N0 (dev job f907220c): the internal webhook secret must never again ship to browsers.
 *
 * The signing pages used to send `NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET` to the offer-signed /
 * agreement-signed webhooks — a NEXT_PUBLIC_ value is baked into every page bundle, so the
 * "secret" that guards invoice-minting webhooks was readable by anyone. Signing now runs its
 * follow-up in-process on the server. This guard fails if any code reads the public copy again.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'

describe('internal webhook secret stays server-only', () => {
  it('no app, component or lib code reads NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET', () => {
    const out = execSync(
      `grep -rln "process.env.NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET" app components lib || true`,
      { cwd: process.cwd(), encoding: 'utf8' },
    ).trim()
    expect(out).toBe('')
  })

  it('the offer signing pages no longer call the signing webhooks from the browser', () => {
    const out = execSync(
      `grep -rln "api/webhooks/offer-signed\\|api/webhooks/agreement-signed" app/offer || true`,
      { cwd: process.cwd(), encoding: 'utf8' },
    ).trim()
    expect(out).toBe('')
  })
})
