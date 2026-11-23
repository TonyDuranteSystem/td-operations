/**
 * Team Powers bug hunt, batch 2 (dev job e59dd470, 20 Nov hunt; Antonio "do all of them", 23 Nov):
 *   - A#8: the owner reads what a tick REALLY allows (the notice and the Team screen read these words): Bank Applications also manages the company's
 *     bank accounts and which one prints on invoices; Company & Services also changes the company logo — in English and Italian;
 *   - F7: the "Generate Documents" menu entry is never shown to a team login (its page needs a person's own contact).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPABILITY_LABELS, describeCapabilities } from '@/lib/portal/team/capability-labels'
import { teammateNavCapability } from '@/lib/portal/team/capabilities'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const label = (key: string) => CAPABILITY_LABELS.find((l) => l.key === key)!

describe('tick wording says what the tick really allows', () => {
  it('Bank Applications: the form AND the company\'s bank accounts / which one is printed on invoices (EN + IT)', () => {
    expect(label('bank_applications').en.hint).toMatch(/bank application/i)
    expect(label('bank_applications').en.hint).toMatch(/bank accounts/i)
    expect(label('bank_applications').en.hint).toMatch(/invoices/i)
    expect(label('bank_applications').it.hint).toMatch(/conti bancari/i)
    expect(label('bank_applications').it.hint).toMatch(/fatture/i)
  })
  it('Company & Services: also changes the company logo (EN + IT)', () => {
    expect(label('company_services').en.hint).toMatch(/logo/i)
    expect(label('company_services').it.hint).toMatch(/logo/i)
  })
  it('the notice an owner reads uses these words', () => {
    const text = describeCapabilities({ bank_applications: true }, 'en').join(' ')
    expect(text).toMatch(/bank accounts/i)
  })
})

describe('the Generate Documents menu entry', () => {
  it('is not mapped to any power: a team login never sees it', () => {
    expect(teammateNavCapability('nav.generateDocuments')).toBeNull()
    expect(teammateNavCapability('nav.documents')).toBe('documents') // the Documents page itself is unchanged
  })
  it('the file header says generating documents is never a tick (the code now agrees)', () => {
    expect(read('lib/portal/team/capabilities.ts')).toMatch(/generating documents, changing owners/)
  })
})

describe('the staff Team card and the owner screens after a half-succeeded switch', () => {
  it('both refresh their list when a switch fails (a switch-off can succeed while its sign-in block fails)', () => {
    expect(read('components/accounts/team-section.tsx')).toContain('void load()')
    expect(read('components/portal/team-manager.tsx')).toMatch(/setError\(r\.error \|\| 'Could not switch the person'\); router\.refresh\(\); return/)
  })
  it('the card draws the history-unreadable notice only while the people and buttons are available', () => {
    const src = read('components/accounts/team-section.tsx')
    expect(src).toContain('data.ready && data.historyAvailable === false')
    expect(src).toContain('const canSwitch = data.ready && m.state !== \'removed\'')
    expect(src).toContain("m.lastSignInUnreadable ? 'could not be checked'")
  })
})
