import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'

// The pieces below render without a running Next router: the router hooks are replaced by plain stand-ins.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => '/portal',
  useSearchParams: () => new URLSearchParams(''),
}))
import { renderToStaticMarkup } from 'react-dom/server'
import { AppCompanyHero } from '@/components/portal/app-overview/company-hero'
import { AppIdentityCard } from '@/components/portal/app-overview/identity-card'
import { AppAddressCards, type AppAddressItem } from '@/components/portal/app-overview/address-cards'
import { PersonalInfoCards } from '@/components/portal/personal-info-cards'
import { ActionItems } from '@/components/portal/action-items'
import { AppModeContext } from '@/lib/app-mode/app-mode-context'
import { LocaleContext } from '@/lib/portal/use-locale'
import type { PersonalInfoData } from '@/lib/portal/personal-info'

// Client iPhone app, Overview redesign (dev job 056a70d0): what the phone's Overview draws, and proof that the website's drawing is untouched.

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const DOT = '•'
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const inApp = (node: React.ReactElement, locale: 'en' | 'it' = 'en') =>
  renderToStaticMarkup(createElement(AppModeContext.Provider, { value: true }, createElement(LocaleContext.Provider, { value: { locale, translations: {} } }, node)))
const onWebsite = (node: React.ReactElement) =>
  renderToStaticMarkup(createElement(AppModeContext.Provider, { value: false }, createElement(LocaleContext.Provider, { value: { locale: 'en', translations: {} } }, node)))

describe('company card', () => {
  const hero = (over: Partial<React.ComponentProps<typeof AppCompanyHero>> = {}) =>
    inApp(createElement(AppCompanyHero, { name: 'Harbor Demo LLC', entityType: 'Single Member LLC', state: 'Wyoming', ein: '12-3456789', formed: 'Mar 14, 2024', filingId: '2024-001234567', news: [], ...over }))

  it('shows the name once as the page heading, the type and state, and the EIN, formation date and filing ID', () => {
    const html = hero()
    expect(html).toContain('data-testid="app-company-hero"')
    expect((html.match(/<h1/g) ?? []).length).toBe(1)
    const t = text(html)
    for (const s of ['Harbor Demo LLC', 'Single Member LLC', 'Wyoming', 'EIN', '12-3456789', 'Formation', 'Mar 14, 2024', 'Filing ID', '2024-001234567', 'Copy']) expect(t).toContain(s)
  })

  it('has no Copy button, and no filing ID box, when the company has neither yet', () => {
    const t = text(hero({ ein: null, filingId: null }))
    expect(t).not.toContain('Copy')
    expect(t).not.toContain('Filing ID')
    expect(t).toContain('—')
  })

  it('speaks Italian to an Italian client', () => {
    const t = text(inApp(createElement(AppCompanyHero, { name: 'X', entityType: null, state: null, ein: '1', formed: '-', filingId: null, news: [] }), 'it'))
    expect(t).toContain('La tua azienda')
    expect(t).toContain('Copia')
  })
})

describe('Identity & Tax card', () => {
  const card = (props: React.ComponentProps<typeof AppIdentityCard>, locale: 'en' | 'it' = 'en') => inApp(createElement(AppIdentityCard, props), locale)

  it('is there with no passport and no ITIN, and says so for each, with where it will appear', () => {
    const html = card({ passport: null, itin: null })
    const t = text(html)
    expect(html).toContain('data-testid="identity-card"')
    expect(html).toContain('data-testid="app-identity-passport"')
    expect(html).toContain('data-testid="app-identity-itin"')
    expect(html).toContain('data-testid="app-itin-empty"')
    expect(t).toContain('Identity & Tax')
    expect(t).toContain('Passport')
    expect(t).toContain('ITIN')
    expect((t.match(/Not on file yet/g) ?? []).length).toBe(2)
    expect(t).toContain('No ITIN on file yet.')
    expect(t).toContain('When an ITIN is issued for you, it appears here.')
    expect(t).toContain('When we have your passport on file, it shows here.')
    expect(t).not.toContain('Show')
  })

  it('shows an ITIN only as its last four characters until the client taps Show, with the dates and the letter note', () => {
    const html = card({ passport: null, itin: { number: '912-34-1234', issued: '08/21/2024', renewal: '12/31/2028' } })
    const t = text(html)
    expect(html).not.toContain('912-34-1234')
    expect(t).toContain(`${DOT}${DOT}${DOT}-${DOT}${DOT}-1234`)
    expect(t).toContain('Show')
    expect(t).toContain('Issued')
    expect(t).toContain('08/21/2024')
    expect(t).toContain('12/31/2028')
    expect(t).toContain('CP565')
    expect(html).not.toContain('data-testid="app-itin-empty"')
  })

  it('hides a passport number the same way and tags the passport On file', () => {
    const html = card({ passport: { onFile: true, number: 'P1234523', expiry: '06/02/2031' }, itin: null })
    const t = text(html)
    expect(html).not.toContain('P1234523')
    expect(t).toContain(`${DOT}${DOT}${DOT}${DOT}4523`)
    expect(t).toContain('On file')
    expect(t).toContain('06/02/2031')
    expect(t).not.toContain('When we have your passport on file')
  })

  it('a passport that is only "on file" (no number, no date) shows just the tag', () => {
    const t = text(card({ passport: { onFile: true, number: null, expiry: null }, itin: null }))
    expect(t).toContain('On file')
    expect(t).not.toContain('When we have your passport on file')
    expect(t).not.toContain('Show')
  })

  it('speaks Italian to an Italian client', () => {
    const t = text(card({ passport: null, itin: null }, 'it'))
    expect(t).toContain('Identità e Tasse')
    expect(t).toContain('Non ancora in archivio')
    expect(t).toContain('Nessun ITIN in archivio.')
  })
})

describe('address cards', () => {
  const item = (over: Partial<AppAddressItem> = {}): AppAddressItem => ({
    key: 'registered-agent', icon: 'shield', tone: 'green', label: 'Registered Agent Address',
    description: 'Required by the state for as long as your company exists. Official legal and state notices are delivered here — check it regularly.',
    rows: [{ key: 'address', label: 'Address', value: '100 Sample Street' }, { key: 'city', label: 'City', value: 'Sample City' }],
    legacy: null, copyText: '100 Sample Street\nSample City, WY 82801', emptyText: 'Not on file', ...over,
  })

  it('draws every address as a card with its full description and a Copy button', () => {
    const html = inApp(createElement(AppAddressCards, { title: 'Addresses', items: [item(), item({ key: 'shipping', label: 'Shipping Address', icon: 'box', tone: 'rose' })] }))
    const t = text(html)
    expect((html.match(/data-testid="app-address-/g) ?? []).length).toBe(3) // the wrapper + two cards
    expect(t).toContain('Addresses')
    expect(t).toContain('Registered Agent Address')
    expect(t).toContain('Official legal and state notices are delivered here — check it regularly.') // never shortened
    expect(t).toContain('100 Sample Street')
    expect((t.match(/Copy address/g) ?? []).length).toBe(2)
  })

  it('an address that is not on file still gets its card (all four always show), with no Copy button', () => {
    const t = text(inApp(createElement(AppAddressCards, { title: 'Addresses', items: [item({ rows: [], copyText: null })] })))
    expect(t).toContain('Registered Agent Address')
    expect(t).toContain('Not on file')
    expect(t).not.toContain('Copy address')
  })

  it('shows the single old free-text line when that is all there is', () => {
    const t = text(inApp(createElement(AppAddressCards, { title: 'Addresses', items: [item({ rows: [], legacy: 'Old line, Somewhere', copyText: 'Old line, Somewhere' })] })))
    expect(t).toContain('Old line, Somewhere')
  })
})

describe('personal cards', () => {
  const data = (identity: PersonalInfoData['identity']): PersonalInfoData => ({
    contactId: 'c1',
    editor: { first_name: 'Alex', last_name: 'Reviewer', email: 'alex@example.com', phone: '+1 555 010 0199', language: 'English', citizenship: '', address_line1: '', address_city: '', address_state: '', address_zip: '', address_country: '' },
    identity,
  })
  const app = (d: PersonalInfoData) => inApp(createElement(PersonalInfoCards, { data: d, locale: 'en', appMode: true }))

  it('the app shows a profile header and a short list, with "Not added yet" instead of dashes', () => {
    const html = app(data(null))
    const t = text(html)
    expect(html).toContain('data-testid="app-profile-view"')
    expect(t).toContain('Your details')
    expect(t).toContain('Alex Reviewer')
    expect(t).toContain('alex@example.com')
    expect(t).toContain('+1 555 010 0199')
    expect(t).toContain('Edit')
    expect(t).toContain('Change Password')
    expect(t).toContain('Not added yet') // citizenship and address
    expect(html).not.toContain('>—<') // no bare dash rows
    // the five separate address fields are gone from the reading view
    for (const gone of ['State / Province', 'ZIP / Postal Code', 'First Name', 'Last Name']) expect(t).not.toContain(gone)
  })

  it('the Identity & Tax card is there even for a person with no passport and no ITIN (identity = null)', () => {
    const html = app(data(null))
    expect(html).toContain('data-testid="identity-card"')
    expect(html).toContain('data-testid="app-itin-empty"')
  })

  it('carries a real ITIN through, written for the phone (hidden until Show)', () => {
    const html = app(data({ passport: null, itin: { number: '912-34-1234', issueDate: '2024-08-21', renewalDate: '2028-12-31' } }))
    const t = text(html)
    expect(html).not.toContain('912-34-1234')
    expect(t).toContain('-1234')
    expect(t).toContain('08/21/2024')
    expect(t).toContain('12/31/2028')
  })

  it('the website is unchanged: no identity card at all without a passport or ITIN, the old label/value list, no app test ids', () => {
    const html = onWebsite(createElement(PersonalInfoCards, { data: data(null), locale: 'en' }))
    const t = text(html)
    expect(html).not.toContain('identity-card')
    expect(html).not.toContain('app-personal-cards')
    expect(html).not.toContain('app-profile-view')
    expect(t).toContain('Personal Information')
    expect(t).toContain('First Name')
    expect(t).toContain('State / Province')
  })
})

describe('action items: nothing pending', () => {
  const empty = { items: [], counts: { red: 0, orange: 0, blue: 0, total: 0 } } as unknown as React.ComponentProps<typeof ActionItems>['data']

  it('is one thin line in the app, and the website\'s big box on the website', () => {
    const app = inApp(createElement(ActionItems, { data: empty }))
    expect(app).toContain('data-testid="app-caught-up"')
    expect(text(app)).toContain('All caught up!')
    const web = onWebsite(createElement(ActionItems, { data: empty }))
    expect(web).not.toContain('app-caught-up')
    expect(web).toContain('p-6 mb-6')
    expect(text(web)).toContain('All caught up!')
  })
})

describe('wiring (source guards)', () => {
  const page = src('app/portal/page.tsx')

  it('the Overview page reads the app flag once, before the personal cards, and hands it to them', () => {
    expect((page.match(/const inClientApp = await getClientAppModeActive\(\)/g) ?? []).length).toBe(1)
    expect(page.indexOf('const inClientApp = await')).toBeLessThan(page.indexOf('const personalCards'))
    expect(page).toContain('appMode={inClientApp} />')
    expect(page).toContain('rowSpan appMode={inClientApp}')
  })

  it('in the app the company card replaces the heading and the Company Info box; the website keeps both', () => {
    expect(page).toContain('<AppCompanyHero')
    expect(page).toContain('news={buildNewsItems({ locale, canManageTeam, announcements: portalAnnouncements })}')
    expect(page).toMatch(/\) : \(\s*<div>\s*<h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">\{account\.company_name\}<\/h1>/)
    expect(page).toMatch(/\{!inClientApp && \(\s*<div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">\s*<h2[^>]*>\{t\('dashboard\.companyInfo'/)
  })

  it('the three announcement kinds are not drawn on the page in the app: they live behind the News button', () => {
    expect(page).toMatch(/\{!inClientApp && \(\s*<>[\s\S]*?<GuideAnnouncementBanner locale=\{locale\} \/>[\s\S]*?<TeamAccessAnnouncementBanner locale=\{locale\} \/>[\s\S]*?<AnnouncementBanners announcements=\{visibleOnWebsite\(portalAnnouncements\)\} locale=\{locale\} \/>[\s\S]*?<\/>\s*\)\}/)
  })

  it('the four addresses are four cards in the app and the website\'s single box otherwise', () => {
    expect(page).toContain('<AppAddressCards')
    expect(page).toMatch(/\{!inClientApp && \(\s*<div className="bg-white rounded-xl border shadow-sm p-5 space-y-3 lg:col-span-2">/)
    expect(page).toContain("const appAddressItems: AppAddressItem[] = inClientApp")
  })

  it('the website banners no longer have an app drawing of their own (the News sheet draws them)', () => {
    for (const f of ['components/portal/guide-announcement-banner.tsx', 'components/portal/team-access-announcement-banner.tsx']) {
      const s = src(f)
      expect(s).not.toContain('useAppMode')
      expect(s).not.toContain('AppAnnouncementCard')
    }
  })

  it('the profile editor only draws the app view when asked, and the Edit button opens the same form', () => {
    const s = src('components/portal/profile-editor.tsx')
    expect(s).toContain('appView = false')
    expect(s).toContain('if (!editing && appView) return <AppProfileView data={data} onEdit={() => setEditing(true)} />')
  })

  it('the News button remembers "closed" under the same keys as the website banners', () => {
    const news = src('lib/portal-app/news.ts')
    expect(news).toContain("'td-guide-relay-docs-v1'")
    expect(news).toContain("'td-team-access-announce-v1'")
    expect(news).toContain("'td-portal-ann-'")
    // the website's banner builds the key as td-portal-ann- + the announcement id (written with a plain join so the lint rule about "${" in strings stays quiet)
    expect(src('components/portal/announcement-banners.tsx')).toContain(['`td-portal-ann-$', '{ann.id}`'].join(''))
  })
  it('the floating banner is drawn by the News button into the page body, hidden while the sheet is open, and remembers itself under its own key', () => {
    const btn = src('components/portal/app-overview/news-button.tsx')
    expect(btn).toContain('AppNewsBanner')
    expect(btn).toContain('banner.length > 0 && !open')
    expect(btn).toContain('bannerKeyFor')
    expect(src('components/portal/app-overview/news-banner.tsx')).toContain('createPortal')
    expect(src('components/portal/app-overview/news-banner.tsx')).toContain('app-news-banner-close')
  })

  it('the home page honours the announcements\' start and end dates, for the website and the app alike', () => {
    const page = src('app/portal/page.tsx')
    expect(page).toContain('active_from, active_until')
    expect(page).toContain('isAnnouncementLive(a, today)')
    expect(page).toContain('easternDateString(new Date())')
  })

  it('the "Latest" pill in the chat is positioned by the tooltip wrapper, not by the button inside it (the button hung off the left edge)', () => {
    const chat = src('components/portal/portal-chat.tsx')
    const at = chat.indexOf("<FastTooltip label={t('portalChat.jumpToLatest')}")
    expect(at).toBeGreaterThan(0)
    const tag = chat.slice(at, chat.indexOf('>', at + 10) + 1)
    expect(tag).toContain('absolute bottom-3 left-1/2 -translate-x-1/2')
    const button = chat.slice(chat.indexOf('<button', at), chat.indexOf('>', chat.indexOf('<button', at)) + 1)
    expect(button).not.toContain('absolute')
    expect(button).not.toContain('left-1/2')
  })
})
