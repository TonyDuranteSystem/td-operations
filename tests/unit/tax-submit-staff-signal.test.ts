// Antonio 2026-11-08: "to-do board is not used. we use What's new" + "there is no email".
// When a client submits the tax questionnaire, staff are told ONLY by the What's New note
// (chat-event `wizard_submitted`). No To-Do board card, no email to support@. These tests read
// the two submit paths' source so a future edit cannot quietly bring either one back.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

function sliceBetween(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('tax submit: What\'s New is the only staff signal', () => {
  const job = read('lib/jobs/handlers/tax-form-setup.ts')
  const portalPath = sliceBetween(job, 'async function handlePortalWizardTaxSetup', 'async function handleMcpApplyChanges')
  const route = read('app/api/tax-form-completed/route.ts')

  it('portal submit job: no To-Do board card and no email to the team', () => {
    expect(portalPath).not.toContain('emitActionNeeded')
    expect(portalPath).not.toContain('gmailPost')
    expect(portalPath).not.toContain('"staff_card"')
    expect(portalPath).not.toContain('"email_notification"')
  })

  it('portal submit job: still posts the What\'s New note', () => {
    expect(portalPath).toContain('emitClientChatEvent')
    expect(portalPath).toContain('event_kind: "wizard_submitted"')
  })

  it('legacy tax-form route: no To-Do board card and no email to the team', () => {
    expect(route).not.toContain('emitActionNeeded')
    expect(route).not.toContain('gmailPost')
    expect(route).not.toContain('"staff_card"')
    expect(route).not.toContain('"email_notification"')
  })

  it('legacy tax-form route: still posts the What\'s New note', () => {
    expect(route).toContain('emitClientChatEvent')
    expect(route).toContain('event_kind: "wizard_submitted"')
  })
})
