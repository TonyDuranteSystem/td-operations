import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The emailed invoice's card-button hint ("+5% card fee … bank transfer has no fee") is
// only as honest as the line that hands the rate to the email builder. sendTDInvoice is
// too heavy to run in a unit test (PDF, Gmail), so pin the wiring in the source — if that
// line is deleted the email silently goes back to "no fee" while the pay link charges it.
describe('invoice send → card fee hint wiring', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'lib/invoice-auto-send.ts'), 'utf8')

  it('the initial invoice email gets the invoice\'s card fee rate from the same lookup the charge uses', () => {
    const start = src.indexOf('purpose: "initial"')
    expect(start).toBeGreaterThan(-1)
    const call = src.slice(start, start + 900)
    expect(call).toMatch(/cardFeeRate:\s*payToken\s*\?\s*await resolveChargeRate\(/)
  })

  it('resolveChargeRate is the one imported from the card fee config (pin + global switch)', () => {
    expect(src).toMatch(/import \{ resolveChargeRate \} from "@\/lib\/payments\/card-fee-config"/)
  })
})
