/**
 * Source-level guards for the State Filing ID check (job 64d2be64). The screens are .tsx and the setup job is a large handler, neither runs
 * in this project's unit environment — so the few connections a bug-hunt found one missing (or only half checked) are pinned here: each
 * assertion fails if that connection is removed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('the old manual onboarding path passes staff\'s Filing ID decision to the setup job', () => {
  const ops = read('lib/operations/onboarding-review.ts')
  const applyFn = ops.slice(ops.indexOf('export async function applyOnboardingReview'), ops.indexOf('export async function confirmPortalWizardOnboarding'))

  it('applyOnboardingReview puts confirmed_filing_id in the job payload (else the job would save the number staff rejected)', () => {
    expect(applyFn).toContain('confirmed_filing_id')
    expect(applyFn).toContain('...(filingId ? { confirmed_filing_id: filingId.value } : {})')
  })

  it('confirmPortalWizardOnboarding does the same', () => {
    expect(ops).toContain('...(filingId ? { confirmed_filing_id: filingId.value } : {}),')
    expect(count(ops, 'confirmed_filing_id: filingId.value')).toBe(2)
  })
})

describe('the setup job saves the Filing ID where the company exists', () => {
  const job = read('lib/jobs/handlers/onboarding-setup.ts')

  it('resolves the number once, then saves it after the account is created/updated and before the suite step', () => {
    const resolveAt = job.indexOf('resolveFilingIdToSave(p, submitted)')
    const saveAt = job.indexOf('await saveCheckedFilingId(account_id, filingIdToSave')
    const suiteAt = job.indexOf('0d. SUITE DECISION')
    const accountAt = job.indexOf('0c. CREATE ACCOUNT IF NOT PROVIDED')
    expect(accountAt).toBeGreaterThan(-1)
    expect(resolveAt).toBeGreaterThan(accountAt)
    expect(saveAt).toBeGreaterThan(resolveAt)
    expect(suiteAt).toBeGreaterThan(saveAt)
  })

  it('says so when the client\'s number was unusable instead of dropping it silently', () => {
    expect(job).toContain('unusableClientFilingId(p, submitted)')
  })
})

describe('Confirm waits for the Filing ID check on both screens', () => {
  it('the formation window guards the click AND disables the button (deleting either must fail a test)', () => {
    const ui = read('components/flows/document-upload.tsx')
    expect(ui).toContain('if (filingIdApplicable && !filingCheck.resolved) {') // the guard inside confirmFormationDate
    expect(ui).toContain('(filingIdApplicable && !filingCheck.resolved)}') // the button's disabled
    expect(count(ui, 'filingIdApplicable && !filingCheck.resolved')).toBe(2)
  })

  it('the onboarding Confirm button is disabled while the gate is blocked and sends the checked number', () => {
    const list = read('app/(dashboard)/onboarding-review/components/onboarding-review-list.tsx')
    expect(list).toContain('filingGate.blocked')
    expect(list).toMatch(/disabled=\{[^}]*filingGate\.blocked/)
    expect(list).toContain('...(filingGate.choice ? { filing_id: filingGate.choice.value } : {})')
  })

  it('a check that could not load sends "no Filing ID" — an unchecked number is never saved', () => {
    const screen = read('app/(dashboard)/onboarding-review/components/onboarding-filing-id-check.tsx')
    expect(screen).toContain("load.status === 'error') onGate({ blocked: false, choice: { value: null } })")
    expect(screen).not.toContain('saved as typed')
  })
})

describe('the floating window only counts a document as viewed once it has really shown', () => {
  const win = read('components/ui/floating-document-window.tsx')
  const card = read('components/flows/filing-id-check-card.tsx')

  it('opening the window does not report "viewed"; loading the PDF / image or using the new-tab link does', () => {
    expect(win).not.toContain('onOpened')
    expect(count(win, 'onLoad={markShown}')).toBe(3) // local-blob PDF, fetched PDF, image
    expect(count(win, 'onClick={markShown}')).toBe(2) // the title-bar link and the "cannot show it" link
    expect(card).toContain('onShown={() => setViewed(true)}')
  })

  it('a right-click does not start a drag', () => {
    expect(win).toContain('e.button !== 0')
  })
})
