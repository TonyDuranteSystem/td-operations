/**
 * Guard (dev job e3215801): the stage-move notice in advanceServiceDelivery (step 8) must ask "does the person the digest would email have the
 * app?" through stageNoticeRecipientHasApp and hand the answer to createPortalNotification as suppressDigestEmail — and the milestone stage email
 * (step 8b) goes through notifyClientOfStageAdvance, which skips app clients itself. The helper's logic is unit-tested in push-presence.test.ts;
 * this pins the WIRING, which is not otherwise covered in CI (the step needs a whole database to run).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(process.cwd(), 'lib/service-delivery.ts'), 'utf8')
const route = readFileSync(join(process.cwd(), 'app/api/flows/[id]/upload-document/route.ts'), 'utf8')
const step8 = src.slice(src.indexOf('// 8. Portal notification for client.'), src.indexOf('// 8a. Phase 4'))

describe('service-delivery step 8 — the stage-move notice skips the digest email for a client who has the app', () => {
  it('the step-8 block exists and creates the "service" bell notice', () => {
    expect(step8.length).toBeGreaterThan(200)
    expect(step8).toContain('type: "service"')
  })
  it('asks the shared per-person/per-company rule, with the case\'s contact AND company', () => {
    expect(step8).toContain('stageNoticeRecipientHasApp')
    expect(step8).toMatch(/stageNoticeRecipientHasApp\(\{\s*contactId: delivery\.contact_id \?\? null,\s*accountId: delivery\.account_id \?\? null\s*\}\)/)
  })
  it('hands the answer to the notice as suppressDigestEmail (the bell row and the push are still created)', () => {
    expect(step8).toContain('suppressDigestEmail: hasApp')
  })
  it('does not use a bare "any device of the company" check here', () => {
    expect(step8).not.toContain('recipientHasPush')
  })
  it('the milestone stage email (8b) still goes through notifyClientOfStageAdvance, which skips app clients per recipient', () => {
    expect(src).toContain('notifyClientOfStageAdvance')
    expect(src).toContain('skippedHasApp')
  })
})

describe('the ITIN letter route only says "client notified" when the portal message really went out', () => {
  it('goes through clientWasTold, and a message that did not go out becomes a warning (shown amber)', () => {
    expect(route).toContain('clientWasTold(itinFinalize.notify)')
    expect(route).toContain('itinFinalize.warnings.push(')
  })
})

