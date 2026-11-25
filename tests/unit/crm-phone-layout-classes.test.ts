/**
 * Source guard for the staff pages' phone layout (dev job b93caec4, 25 Nov 2026).
 * A phone is ~360-430 px wide. These pages were wider than the screen: a one-column grid with no explicit column
 * grows to its widest child, and rows of buttons that cannot wrap run off the edge. The classes below are what keeps
 * them on screen, and each is unchanged at lg and up. The real proof is measuring `main.scrollWidth - main.clientWidth`
 * at 360 / 390 / 430 px in a browser (docs/systems/crm-core.md, 2026-11-25); this test only stops a later edit from
 * quietly removing the classes.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('company page', () => {
  const page = read('app/(dashboard)/accounts/[id]/page.tsx')

  it('top button row wraps, so View as client stays on screen', () => {
    expect(page).toContain('mb-4 flex flex-wrap justify-start gap-2 sm:justify-end')
  })

  it('button labels do not break onto several lines', () => {
    expect(page.match(/inline-flex items-center gap-1\.5 whitespace-nowrap rounded-md/g)?.length).toBe(2)
    expect(read('components/accounts/view-as-client-button.tsx')).toContain('inline-flex items-center gap-1.5 whitespace-nowrap')
  })
})

describe('account-detail.tsx grids', () => {
  const src = read('components/accounts/account-detail.tsx')

  it('the two-column card grid starts as one real column on a phone', () => {
    expect(src).toContain('grid grid-cols-1 gap-6 lg:grid-cols-2')
  })

  it('every grid that becomes several columns later says grid-cols-1 first', () => {
    const offenders = [...src.matchAll(/className="([^"]*)"/g)]
      .map(m => m[1])
      .filter(c => /(^|\s)grid(\s|$)/.test(c) && /(sm|md|lg):grid-cols-/.test(c) && !/(^|\s)grid-cols-/.test(c))
    expect(offenders).toEqual([])
  })

  it('the contact rows and the member header wrap', () => {
    expect(src).toContain('pl-9 grid grid-cols-1 gap-1.5')
    expect(src).toContain('flex flex-wrap items-center justify-between gap-2')
  })
})

describe('document rows', () => {
  it('the actions of a document row wrap instead of running off the edge', () => {
    const src = read('app/(dashboard)/accounts/[id]/components/documents-panel.tsx')
    expect(src).toContain('flex flex-wrap items-center justify-between gap-y-2 px-4 py-2.5 text-sm')
    expect(src).toContain('flex max-w-full flex-wrap items-center gap-2 ml-2')
  })
})

describe('inline-edit field', () => {
  it('a long value wraps and can shrink inside its row', () => {
    const src = read('components/accounts/editable-field.tsx')
    expect(src).toContain('font-medium text-sm flex-1 min-w-0 break-words')
    expect(src).toContain('flex-1 min-w-0 space-y-1')
  })
})

describe('contact page header', () => {
  it('the buttons and the name block wrap', () => {
    const src = read('components/contacts/contact-detail.tsx')
    expect(src).toContain('flex flex-wrap items-start justify-between gap-4')
    expect(src).toContain('flex min-w-0 items-center gap-3')
    expect(src).toContain('flex flex-wrap items-center gap-2')
  })
})

describe('list filters', () => {
  it('a segmented filter scrolls inside its own row and never widens the page', () => {
    const src = read('components/lists/segmented-filter.tsx')
    expect(src).toContain('flex min-w-0 max-w-full flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2')
    expect(src).toContain('inline-flex min-w-0 max-w-full overflow-x-auto')
  })
})

describe('Booking Leads tab header', () => {
  it('the title row and its buttons wrap', () => {
    const src = read('components/leads/leads-workspace.tsx')
    expect(src).toContain('flex flex-wrap items-center justify-between gap-3 mb-6')
    expect(src).toContain('flex flex-wrap items-center gap-3')
  })
})

describe('workspace banner cards', () => {
  const files: Array<[string, number]> = [
    ['formation', 1],
    ['onboarding', 2],
    ['tax', 1],
    ['itin', 1],
    ['closure', 1],
  ]

  it.each(files)('the %s banner stacks its button under the text on a phone', (name, cards) => {
    const src = read(`components/flows/${name}-workspace-banner.tsx`)
    const count = (needle: string) => src.split(needle).length - 1
    expect(count('flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border-2')).toBe(cards)
    expect(count('min-w-0 flex-[1_1_10rem]')).toBe(cards)
    expect(count('inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-lg')).toBe(cards)
    expect(count('sm:w-auto')).toBe(cards)
  })
})
