/**
 * Client portal: the flat menu and the personal cards on Panoramica (Antonio, 2026-11-05).
 *
 *  - The menu is ONE list (no "Personale" / "Aziende" headings), in Antonio's order; Profilo and TD Communication
 *    are no longer menu entries (their pages still exist).
 *  - "Informazioni Personali" (same form and save as Profilo) and a read-only "Identità e Tasse" card (passport +
 *    ITIN) live on every Panoramica screen; the four old cards (Servizi Attivi, Scadenze Imminenti, Storico
 *    Pagamenti, Dichiarazioni Fiscali) are gone from the company-client page.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { t } from '@/lib/portal/i18n'
import {
  buildEditorData,
  buildIdentityCard,
  formatPersonalDate,
  PERSONAL_INFO_COLUMNS,
} from '@/lib/portal/personal-info'

const side = readFileSync('components/portal/portal-sidebar.tsx', 'utf8')
const home = readFileSync('app/portal/page.tsx', 'utf8')
const cards = readFileSync('components/portal/personal-info-cards.tsx', 'utf8')

/** The `key:` of every entry of one top-level `const <name>: NavItem[] = [ ... ]` block, in order. */
function navKeys(source: string, listName: string): string[] {
  const start = source.indexOf(`const ${listName}: NavItem[] = [`)
  expect(start, `${listName} not found`).toBeGreaterThan(-1)
  const end = source.indexOf('\n]\n', start)
  return [...source.slice(start, end).matchAll(/key: '(nav\.[A-Za-z]+)'/g)].map(m => m[1])
}

describe('the menu is one flat list in Antonio\'s order', () => {
  it('lists the items in the agreed order, with Apertura Conto Bancario above Richiedi un Servizio and La Mia Azienda last', () => {
    expect(navKeys(side, 'mainItems')).toEqual([
      'nav.overview',
      'nav.chat',
      'nav.referrals',
      'nav.myClients', // only for companies WITHOUT the new invoices screen
      'nav.invoices', // "Clienti e Fatture"
      'nav.documents',
      'nav.team',
      'nav.generateDocuments',
      'nav.signDocuments',
      'nav.tdBilling', // "Fatture TD"
      'nav.bankApplications',
      'nav.requestService',
      'nav.myCompany',
    ])
  })

  it('has no Profilo and no TD Communication entry anywhere in the menu', () => {
    for (const list of ['mainItems', 'tierTopItems', 'partnerItems', 'bottomItems']) {
      const keys = navKeys(side, list)
      expect(keys).not.toContain('nav.profile')
      expect(keys).not.toContain('nav.tdCommunication')
    }
    expect(side).not.toContain("href: '/portal/profile'")
    expect(side).not.toContain("href: '/portal/td-communication'")
  })

  it('no longer draws the Personale / Aziende headings', () => {
    expect(side).not.toContain('SECTION_LABELS')
    expect(side).not.toContain("it: 'Personale'")
    expect(side).not.toContain("it: 'Aziende'")
    expect(side).not.toContain('personalLabel')
    expect(side).not.toContain('companiesLabel')
  })

  it('Panoramica is open to everyone (no company needed); every company page item needs a company', () => {
    const block = side.slice(side.indexOf('const mainItems: NavItem[] = ['), side.indexOf('\n]\n', side.indexOf('const mainItems')))
    expect(block).toMatch(/key: 'nav\.overview'[^\n]*\}/)
    expect(block.match(/key: 'nav\.overview'[^\n]*/)![0]).not.toContain('needsCompany')
    for (const k of ['nav.chat', 'nav.referrals', 'nav.requestService']) {
      expect(block.match(new RegExp(`key: '${k.replace('.', '\\.')}'[^\\n]*`))![0]).not.toContain('needsCompany')
    }
    for (const k of ['nav.myClients', 'nav.invoices', 'nav.documents', 'nav.team', 'nav.generateDocuments', 'nav.signDocuments', 'nav.tdBilling', 'nav.bankApplications', 'nav.myCompany']) {
      expect(block.match(new RegExp(`key: '${k.replace('.', '\\.')}'[^\\n]*`))![0], k).toContain('needsCompany: true')
    }
  })

  it('with no company yet the invoices slot holds the personal-receipts variant', () => {
    expect(side).toMatch(/item\.key === 'nav\.invoices' && !showCompaniesSection \? personalInvoicesItem : item/)
  })

  it('keeps the tier calls to action (offer for leads, complete-setup for onboarding) and Guida', () => {
    expect(navKeys(side, 'tierTopItems')).toEqual(['nav.offer', 'nav.wizard'])
    expect(navKeys(side, 'bottomItems')).toEqual(['nav.guide'])
  })
})

describe('Profilo page and TD Communication page still exist (only the menu entries left)', () => {
  it('keeps the routes alive: suspended clients can only reach chat, profile and settings', () => {
    expect(existsSync('app/portal/profile/page.tsx')).toBe(true)
    expect(existsSync('app/portal/td-communication/page.tsx')).toBe(true)
    expect(readFileSync('components/portal/suspended-guard.tsx', 'utf8')).toContain("'/portal/profile'")
  })
})

describe('Panoramica (company-client page)', () => {
  it('no longer shows the four old cards', () => {
    for (const k of ['dashboard.activeServices', 'dashboard.upcomingDeadlines', 'dashboard.paymentHistory', 'dashboard.taxReturns']) {
      expect(home, k).not.toContain(`t('${k}'`)
    }
    expect(home).not.toContain('<PaymentHistory')
  })

  it('keeps what stays: company info, addresses, members, tax banner/tracker, Stato dei Servizi, action items', () => {
    expect(home).toContain("t('dashboard.companyInfo'")
    expect(home).toContain("t('addresses.title'")
    expect(home).toContain("t('dashboard.members'")
    expect(home).toContain('<TaxProgressTracker')
    expect(home).toContain("t('flows.serviceStatus'")
    expect(home).toContain('<ActionItems')
  })

  it('puts the personal cards in the grid, right after Info Azienda', () => {
    const i = home.indexOf("t('dashboard.companyInfo'")
    const j = home.indexOf('<PersonalInfoCards data={personalInfo}', i)
    const k = home.indexOf("t('addresses.title'", i)
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    expect(j).toBeLessThan(k)
    expect(home).toContain('rowSpan />')
  })

  it('shows the personal cards under EVERY other dashboard (formation, welcome / lead / onboarding)', () => {
    const dashboards = (home.match(/^\s*<(FormationDashboard|WelcomeDashboard)$/gm) ?? []).length
    const placed = (home.match(/^\s*\{personalCards\}$/gm) ?? []).length
    expect(dashboards).toBeGreaterThanOrEqual(7)
    expect(placed).toBe(dashboards)
  })

  it('a team member (no contact) never gets the personal cards', () => {
    expect(home).toContain('const personalInfo = await getPersonalInfo(contactId)')
    // the teammate early return happens before personalInfo is even loaded
    expect(home.indexOf("kind === 'team_member'")).toBeLessThan(home.indexOf('const personalInfo = await getPersonalInfo'))
  })
})

describe('the personal cards component', () => {
  it('reuses the Profilo editor and links to Cambia Password', () => {
    expect(cards).toContain('<ProfileEditor contactId={data.contactId} initialData={data.editor} />')
    expect(cards).toContain('href="/portal/settings"')
    expect(cards).toContain("tr('profile.changePassword')")
  })

  it('shows passport and ITIN read-only (no inputs, no save path of its own)', () => {
    expect(cards).not.toContain('<input')
    expect(cards).not.toContain('fetch(')
    expect(cards).toContain("tr('profile.passportNumber')")
    expect(cards).toContain("tr('profile.itinNumber')")
  })

  it('shows no empty number / date fields when the passport is only marked "on file"', () => {
    expect(cards).toContain('(identity.passport.number || identity.passport.expiry) && (')
  })

  it('only spans two rows on the company page and only when an identity card exists', () => {
    expect(cards).toContain("rowSpan && identity && 'lg:row-span-2'")
  })
})

describe('buildIdentityCard', () => {
  it('is null when there is no contact, or neither passport details nor an ITIN', () => {
    expect(buildIdentityCard(null)).toBeNull()
    expect(buildIdentityCard(undefined)).toBeNull()
    expect(buildIdentityCard({})).toBeNull()
    expect(buildIdentityCard({ passport_number: '  ', itin_number: '', passport_on_file: false })).toBeNull()
    expect(buildIdentityCard({ passport_on_file: null, passport_expiry_date: null, itin_issue_date: '2025-10-03' })).toBeNull()
  })

  it('shows the passport block for a number, an expiry date, or just "on file"', () => {
    expect(buildIdentityCard({ passport_number: 'YA0000000' })?.passport).toEqual({ onFile: false, number: 'YA0000000', expiry: null })
    expect(buildIdentityCard({ passport_expiry_date: '2031-03-14' })?.passport).toEqual({ onFile: false, number: null, expiry: '2031-03-14' })
    expect(buildIdentityCard({ passport_on_file: true })?.passport).toEqual({ onFile: true, number: null, expiry: null })
  })

  it('shows the ITIN block only with an ITIN number (the rule Profilo always had)', () => {
    const c = buildIdentityCard({ itin_number: ' 912-70-0000 ', itin_issue_date: '2025-10-03', itin_renewal_date: null })
    expect(c?.itin).toEqual({ number: '912-70-0000', issueDate: '2025-10-03', renewalDate: null })
    expect(c?.passport).toBeNull()
  })

  it('shows both when both exist', () => {
    const c = buildIdentityCard({ passport_number: 'YA0000000', passport_on_file: true, itin_number: '912-70-0000' })
    expect(c?.passport?.onFile).toBe(true)
    expect(c?.itin?.number).toBe('912-70-0000')
  })
})

describe('buildEditorData', () => {
  it('hands the editor strings only, never null', () => {
    const e = buildEditorData({ first_name: 'Mario', last_name: null, email: 'm@example.com' })
    expect(e.first_name).toBe('Mario')
    expect(e.last_name).toBe('')
    expect(e.address_country).toBe('')
    expect(Object.values(e).every(v => typeof v === 'string')).toBe(true)
    expect(buildEditorData(null).email).toBe('')
  })
})

describe('formatPersonalDate', () => {
  it('shows a calendar date in the client\'s language without a timezone shift', () => {
    expect(formatPersonalDate('2031-03-14', 'it')).toBe('14/03/2031')
    expect(formatPersonalDate('2031-03-14', 'en')).toBe('03/14/2031')
    expect(formatPersonalDate('2031-12-31', 'it')).toBe('31/12/2031')
    expect(formatPersonalDate('2031-01-01T00:00:00+00:00', 'it')).toBe('01/01/2031')
  })

  it('shows a dash for nothing and leaves an odd value as it is', () => {
    expect(formatPersonalDate(null, 'it')).toBe('—')
    expect(formatPersonalDate('', 'it')).toBe('—')
    expect(formatPersonalDate('soon', 'it')).toBe('soon')
    expect(formatPersonalDate('2031-13-45', 'en')).not.toBe('')
  })
})

describe('what is read from the contact', () => {
  it('is an explicit column list (never *) that includes the passport and ITIN columns', () => {
    expect(PERSONAL_INFO_COLUMNS).not.toContain('*')
    for (const c of ['passport_number', 'passport_expiry_date', 'passport_on_file', 'itin_number', 'itin_issue_date', 'itin_renewal_date', 'first_name', 'address_country']) {
      expect(PERSONAL_INFO_COLUMNS).toContain(c)
    }
    // nothing like a date of birth or a tax id is read for this card
    expect(PERSONAL_INFO_COLUMNS).not.toContain('date_of_birth')
    expect(PERSONAL_INFO_COLUMNS).not.toContain('ssn')
  })
})

describe('labels', () => {
  it('has the passport labels in English and Italian', () => {
    expect(t('profile.passport', 'en')).toBe('Passport')
    expect(t('profile.passport', 'it')).toBe('Passaporto')
    expect(t('profile.passportNumber', 'it')).toBe('Numero Passaporto')
    expect(t('profile.passportExpiry', 'it')).toBe('Scadenza Passaporto')
    expect(t('profile.passportOnFile', 'it')).toBe('In archivio')
    expect(t('profile.passportOnFile', 'en')).toBe('On file')
  })
})
