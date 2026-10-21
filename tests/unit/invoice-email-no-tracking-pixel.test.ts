import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * A client's invoice / reminder email to THEIR customer carries NO open-tracking picture: a per-recipient pixel needs the
 * recipient's prior consent under the Italian Garante's rules (deadline 28 Oct 2026), and Resend flags an image hosted off
 * the sending domain. These routes build the email inline, so the guard reads their source.
 */
const routes = [
  'app/api/portal/invoices/[id]/send/route.ts',
  'app/api/portal/invoices/[id]/remind/route.ts',
]

describe('client invoice emails have no tracking picture', () => {
  for (const file of routes) {
    const src = readFileSync(file, 'utf8')
    it(`${file} adds no tracking pixel`, () => {
      expect(src).not.toMatch(/track\/open/)
      expect(src).not.toMatch(/trackedHtml/)
      expect(src).not.toMatch(/width="1"\s+height="1"/)
    })
    it(`${file} still records the email (claim row) and sends the plain html`, () => {
      expect(src).toContain("from('email_tracking').insert(")
      expect(src).toMatch(/html,\n/)
    })
  }
})
