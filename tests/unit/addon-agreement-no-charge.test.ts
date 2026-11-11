import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isNoChargeFee } from '@/lib/offers/fee-label'

/**
 * A service bundled in another price (a Company Closure included in the formation price) is sold at $0. The standalone
 * agreement already said "Included — no separate charge"; the inline add-on agreements INSIDE the formation / onboarding
 * contract still printed "total fee €0, payable in full before services begin ... All fees are non-refundable"
 * (seen in the sandbox browser, 2026-11-11, dev job 9829a468 — Contrabona: the owner had to invent an €800 price).
 */
const FILES = ['app/offer/[token]/contract/page.tsx', 'app/offer/[token]/contract/service-agreement.tsx']

describe('inline add-on agreements — a $0 / included service', () => {
  for (const f of FILES) {
    const src = readFileSync(join(process.cwd(), f), 'utf8')
    it(`${f}: the Fee row and the Payment section say "included", and the paid wording is kept for a real fee`, () => {
      expect(src).toContain("import { isNoChargeFee } from '@/lib/offers/fee-label'")
      expect(src).toContain("{isNoChargeFee(svcFee) ? 'Included \\u2014 no separate charge' : <>{svcFee} (one-time)</>}")
      expect(src).toContain('No service fee is payable to the Service Provider for this service itself; it is included in your offer.')
      // the paid wording is still there, now only for a real fee
      expect(src).toContain('The total fee for this service is <strong>{svcFee}</strong>, payable in full before services begin.')
      expect(src.indexOf('isNoChargeFee(svcFee) ? (')).toBeLessThan(src.indexOf('The total fee for this service is <strong>{svcFee}</strong>'))
    })
  }
  it('what counts as "no charge" is the offer engine\'s own rule: $0, €0.00, Included, Free — never a real or recurring price', () => {
    for (const f of ['€0', '$0', 'Included', 'Free']) expect(isNoChargeFee(f), f).toBe(true)
    for (const f of ['€800', '$300', '$0/year']) expect(isNoChargeFee(f), f).toBe(false)
  })
})
