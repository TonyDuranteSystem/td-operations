import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')

describe('Documents page: the client\'s own uploads stay on the list', () => {
  const page = src('app/portal/documents/page.tsx')
  it('reads the hidden stored rows and keeps only the signed-in person\'s own uploads, tagged waiting', () => {
    expect(page).toContain("or('portal_visible.is.null,portal_visible.eq.false')")
    expect(page).toContain('listDocsWithOwnUploads')
    expect(page).toContain('placeWaitingUploads')
    expect(page).toContain('waitingIds={Array.from(waitingIds)}')
  })
  it('never sends the owner id, flow stage or visibility flag of those rows to the browser', () => {
    const block = page.slice(page.indexOf('const waiting = ownDocs'), page.indexOf('const alreadyListed'))
    expect(block).toContain('id: d.id, file_name: d.file_name')
    expect(block).not.toContain('contact_id')
    expect(block).not.toContain('portal_visible')
    expect(block).not.toContain('flow_stage')
  })
  it('does not count a waiting upload as a "new" document (the new pill is for what staff pushed)', () => {
    expect(page).toContain('.filter(id => !waitingIds.has(id))')
  })
  it('a waiting upload cannot be previewed or downloaded (the download route refuses it), only tagged', () => {
    const list = src('components/portal/document-list.tsx')
    expect(list).toContain('doc-waiting-review')
    expect(list).toContain("t('taxDocs.waitingReview')")
    expect(list.match(/!isWaiting\(doc\.id\)/g)?.length).toBe(2)
  })
})

describe('Invoices Setup screen: the steps are taps inside the app only', () => {
  const page = src('app/portal/invoices/page.tsx')
  it('uses the tap target only in app mode, so the website keeps its plain list', () => {
    const at = page.indexOf('const href = appMode && guides')
    expect(at).toBeGreaterThan(0)
    expect(page.slice(at, at + 400)).toContain(': null')
    expect(page).toContain('setupScreenStepTarget(')
  })
  it('the logo and bank cards carry the ids the steps jump to', () => {
    expect(page).toContain('id={SETUP_LOGO_ANCHOR}')
    expect(page).toContain('id={SETUP_BANK_ANCHOR}')
  })
  it('the list card keeps the managed company on its links too', () => {
    expect(page).toContain('visibleTabs.map(x => x.id), partnerAccountId)')
  })
})
