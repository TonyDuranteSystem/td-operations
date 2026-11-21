// Antonio 2026-11-21: "I don't want to receive any email on support." Five groups of notice
// emails to support@ were removed: the daily RA renewal report, "Lease Signed", "OA Signed" /
// "OA Partial Sign", "Document Signed" and the "Onboarding Auto-Chain" summary. These tests read
// the source so a future edit cannot quietly bring one back, and prove the staff signal each one
// leaves behind (task / What's New note) is still there.
//
// The emails that were KEPT on purpose are guarded too: they carry the signed file Luca prints and
// sends (SS-4 fax package, Form 8832 mail package) or report something that needs a person and has
// no other trace (signed on paper, declined e-sign, a formation re-submit).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const REMOVED: Array<[string, string]> = [
  ['RA renewal cron', 'app/api/cron/ra-renewal-check/route.ts'],
  ['lease signed', 'app/api/lease-signed/route.ts'],
  ['OA signed (full + partial)', 'app/api/oa-signed/route.ts'],
  ['document signed (e-sign)', 'app/api/signature-request-signed/route.ts'],
  ['onboarding auto-chain job', 'lib/jobs/handlers/onboarding-setup.ts'],
]

const KEPT: Array<[string, string]> = [
  ['SS-4 fax package', 'app/api/ss4-signed/route.ts'],
  ['Form 8832 mail package', 'app/api/8832-signed/route.ts'],
  ['OA signed on paper', 'app/api/operating-agreement/[token]/hand-signed/route.ts'],
  ['e-sign declined', 'app/api/sign/[token]/decline/route.ts'],
  ['formation job (carries the re-submit alert)', 'lib/jobs/handlers/formation-setup.ts'],
]

describe('removed notice emails to support@', () => {
  for (const [name, file] of REMOVED) {
    it(`${name}: no email is sent to the support inbox`, () => {
      const src = read(file)
      expect(src).not.toContain('gmailPost')
      expect(src).not.toContain('To: support@tonydurante.us')
    })
  }

  it('RA renewal cron: still creates the renewal To-Do card and the blocked task', () => {
    const src = read('app/api/cron/ra-renewal-check/route.ts')
    expect(src).toContain('emitActionNeeded')
    expect(src).toContain('RA Renewal blocked')
  })

  it('lease signed: still posts the What\'s New note and the Form 1583 task', () => {
    const src = read('app/api/lease-signed/route.ts')
    expect(src).toContain('emitLeaseSignedEvent')
    expect(src).toContain('task_form_1583')
  })

  it('document signed: the Luca task is still created and carries the not-filed warning', () => {
    const src = read('app/api/signature-request-signed/route.ts')
    expect(src).toContain('task_title: `Document signed:')
    expect(src).toContain('is NOT filed in the CRM storage')
  })
})

describe('onboarding auto-chain job: the review task replaces the summary email', () => {
  const src = read('lib/jobs/handlers/onboarding-setup.ts')

  it('still creates the Luca review task, and names every failed step in it', () => {
    expect(src).toContain('Portal Wizard: Onboarding data submitted')
    expect(src).toContain('const failedSteps = result.steps.filter(x => x.status === "error")')
    expect(src).toContain('...failedSteps.map(f =>')
    expect(src).toContain('step(s) FAILED — open the job result to see why:')
  })

  it('the owner\'s "We received your onboarding data" notice skips the digest email but keeps bell/push', () => {
    const i = src.indexOf('title: "We received your onboarding data"')
    expect(i).toBeGreaterThan(-1)
    const block = src.slice(i, src.indexOf('portal_notification', i))
    expect(block).toContain('suppressDigestEmail: true')
  })

  it('the owner still gets the welcome chat message', () => {
    expect(src).toContain('PORTAL CHAT WELCOME MESSAGE')
  })
})

describe('kept emails to support@ (they carry a file or need a person)', () => {
  for (const [name, file] of KEPT) {
    it(`${name}: still emails the support inbox`, () => {
      const src = read(file)
      expect(src).toContain('gmailPost')
      expect(src).toContain('To: support@tonydurante.us')
    })
  }
})
