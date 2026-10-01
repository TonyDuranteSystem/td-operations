import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Small fixes from the 2026-10-01 production QA of the suite lock.
describe('onboarding setup job — a suite choice it cannot apply must be reported, not dropped', () => {
  const job = readFileSync('lib/jobs/handlers/onboarding-setup.ts', 'utf8')
  it('says so when staff chose "Issue suite" but there is no company', () => {
    expect(job).toContain('else if (!account_id && p.suite_choice === "issue")')
    expect(job).toContain('the suite was NOT issued')
  })
})

describe('wording that used to contradict how suites work today', () => {
  it('the lease dialog no longer says the suite is auto-assigned', () => {
    const d = readFileSync('app/(dashboard)/accounts/[id]/components/generate-lease-dialog.tsx', 'utf8')
    expect(d).not.toMatch(/auto-assigned \(next available/)
    expect(d).toContain('must already be issued')
  })
  it('the portal Principal Office subtitle no longer promises a lease the company may not have (EN + IT)', () => {
    const i = readFileSync('lib/portal/i18n.ts', 'utf8')
    expect(i).toContain('"Our Largo office, with your own suite number."')
    expect(i).toContain('"Il nostro ufficio di Largo, con il tuo numero di suite."')
    expect(i).not.toContain('This is the address on your lease agreement')
  })
  it('the lease tool no longer tells staff to set a sent lease back to draft (the database refuses it)', () => {
    const t = readFileSync('lib/mcp/tools/lease.ts', 'utf8')
    expect(t).not.toContain('set status back to "draft"')
    expect(t).toContain('A sent lease cannot be set back to draft')
  })
  it('the installment email no longer says the lease is created automatically', () => {
    const h = readFileSync('lib/installment-handler.ts', 'utf8')
    expect(h).not.toContain('lease is created automatically')
  })
})
