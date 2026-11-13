import { describe, it, expect } from 'vitest'
import { maskSecret } from '@/lib/portal-app/mask'
import { addressView, initialsFor, profileAddressLines } from '@/lib/portal-app/overview-format'
import {
  ANNOUNCEMENT_DISMISS_PREFIX,
  BANNER_DISMISS_PREFIX,
  GUIDE_COPY,
  GUIDE_DISMISS_KEY,
  GUIDE_HREF,
  TEAM_COPY,
  TEAM_DISMISS_KEY,
  TEAM_HREF,
  bannerItems,
  earlierNewsItems,
  bannerKeyFor,
  buildNewsItems,
  isTeamAnnouncement,
  visibleNewsItems,
  type NewsAnnouncementRow,
} from '@/lib/portal-app/news'

// Client iPhone app, Overview redesign (dev job 056a70d0): the pure pieces behind the News button, the hidden numbers and the address cards.

const DOT = '•'

describe('maskSecret', () => {
  it('hides everything but the last four letters/digits and keeps the dashes where they were', () => {
    expect(maskSecret('912-34-1234')).toBe(`${DOT}${DOT}${DOT}-${DOT}${DOT}-1234`)
    expect(maskSecret('P1234523')).toBe(`${DOT}${DOT}${DOT}${DOT}4523`)
    expect(maskSecret('912 34 1234')).toBe(`${DOT}${DOT}${DOT} ${DOT}${DOT} 1234`)
  })

  it('hides a short value completely, so nothing is gained by showing it', () => {
    expect(maskSecret('1234')).toBe(`${DOT}${DOT}${DOT}${DOT}`)
    expect(maskSecret('AB')).toBe(`${DOT}${DOT}`)
  })

  it('leaves an empty value, or one with no letters or digits, as it is', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret('---')).toBe('---')
  })

  it('never shows more than the last four characters of a longer value', () => {
    const out = maskSecret('9123456789')
    expect(out.endsWith('6789')).toBe(true)
    expect(out.slice(0, -4)).toBe(DOT.repeat(6))
    expect(out).not.toContain('9123')
  })
})

describe('initialsFor', () => {
  it('uses the first letter of the first and last name', () => {
    expect(initialsFor('alex', 'reviewer')).toBe('AR')
    expect(initialsFor(' Maria ', ' de Luca ')).toBe('MD')
  })

  it('falls back to one letter of the name, then of the e-mail, then a dot', () => {
    expect(initialsFor('Alex', '')).toBe('A')
    expect(initialsFor(null, null, 'zed@example.com')).toBe('Z')
    expect(initialsFor('', '', '')).toBe(DOT)
    expect(initialsFor(undefined, undefined)).toBe(DOT)
  })
})

describe('profileAddressLines', () => {
  it('writes the person\'s address as street, city + state + zip, country', () => {
    expect(profileAddressLines({ address_line1: '100 Sample Street', address_city: 'Sample City', address_state: 'FL', address_zip: '33770', address_country: 'United States' }))
      .toEqual(['100 Sample Street', 'Sample City, FL 33770', 'United States'])
  })

  it('skips what is empty and never leaves a stray comma', () => {
    expect(profileAddressLines({ address_city: 'Milano', address_country: 'Italy' })).toEqual(['Milano', 'Italy'])
    expect(profileAddressLines({ address_state: 'FL', address_zip: '33770' })).toEqual(['FL 33770'])
    expect(profileAddressLines({ address_line1: '  ', address_city: ' ' })).toEqual([])
    expect(profileAddressLines({})).toEqual([])
  })
})

describe('addressView', () => {
  const labels = { address: 'Address', suite: 'Suite', city: 'City', state: 'State', zip: 'Zip Code' }
  const parts = { address_line1: '100 Sample Street', address_line2: 'Suite 12', city: 'Sample City', state: 'WY', zip: '82801' }

  it('gives the five labelled lines when street, city, state and zip are all there, with the suite only when there is one', () => {
    const v = addressView(parts, null, labels)
    expect(v.rows.map(r => r.key)).toEqual(['address', 'suite', 'city', 'state', 'zip'])
    expect(v.rows.map(r => r.value)).toEqual(['100 Sample Street', 'Suite 12', 'Sample City', 'WY', '82801'])
    expect(addressView({ ...parts, address_line2: null }, null, labels).rows.map(r => r.key)).toEqual(['address', 'city', 'state', 'zip'])
  })

  it('copies the address the way it is written on an envelope', () => {
    expect(addressView(parts, null, labels).copyText).toBe('100 Sample Street\nSuite 12\nSample City, WY 82801')
    expect(addressView({ ...parts, address_line2: '' }, null, labels).copyText).toBe('100 Sample Street\nSample City, WY 82801')
  })

  it('falls back to the single old free-text line when the structured address is incomplete, exactly as the website does', () => {
    const v = addressView({ ...parts, zip: '' }, 'Old line, Somewhere', labels)
    expect(v.rows).toEqual([])
    expect(v.legacy).toBe('Old line, Somewhere')
    expect(v.copyText).toBe('Old line, Somewhere')
  })

  it('is empty (nothing to copy) when no address is on file at all', () => {
    expect(addressView(null, null, labels)).toEqual({ rows: [], legacy: null, copyText: null })
    expect(addressView(undefined, '   ', labels)).toEqual({ rows: [], legacy: null, copyText: null })
  })
})

describe('buildNewsItems', () => {
  const ann = (over: Partial<NewsAnnouncementRow> = {}): NewsAnnouncementRow => ({
    id: 'a1', title: 'Titolo', message: 'Messaggio', title_en: 'Title', message_en: 'Message', type: 'info', dismissible: true, ...over,
  })

  it('always has the Relay guide, and the team-invite card only for the people who can invite teammates', () => {
    expect(buildNewsItems({ locale: 'en', canManageTeam: false, announcements: [] }).map(i => i.id)).toEqual(['guide-relay-docs'])
    expect(buildNewsItems({ locale: 'en', canManageTeam: true, announcements: [] }).map(i => i.id)).toEqual(['guide-relay-docs', 'team-access'])
  })

  it('uses the same words and links as the website\'s cards, in the client\'s language', () => {
    const en = buildNewsItems({ locale: 'en', canManageTeam: true, announcements: [] })
    expect(en[0]).toMatchObject({ title: GUIDE_COPY.en.title, desc: GUIDE_COPY.en.desc, cta: GUIDE_COPY.en.cta, href: GUIDE_HREF, dismissKey: GUIDE_DISMISS_KEY, tone: 'blue', icon: 'globe' })
    expect(en[1]).toMatchObject({ title: TEAM_COPY.en.title, cta: TEAM_COPY.en.cta, href: TEAM_HREF, dismissKey: TEAM_DISMISS_KEY, tone: 'violet', icon: 'users' })
    const it = buildNewsItems({ locale: 'it', canManageTeam: true, announcements: [] })
    expect(it[1]).toMatchObject({ title: TEAM_COPY.it.title, desc: TEAM_COPY.it.desc, cta: TEAM_COPY.it.cta, dismissLabel: TEAM_COPY.it.dismiss })
  })

  it('adds the announcements the team wrote, with the website\'s language rule and the website\'s "closed" key', () => {
    const [, a] = buildNewsItems({ locale: 'en', canManageTeam: false, announcements: [ann()] })
    expect(a).toMatchObject({ id: 'announcement-a1', title: 'Title', desc: 'Message', cta: null, href: null, dismissKey: `${ANNOUNCEMENT_DISMISS_PREFIX}a1`, icon: 'megaphone', tone: 'blue' })
    const [, b] = buildNewsItems({ locale: 'it', canManageTeam: false, announcements: [ann()] })
    expect(b).toMatchObject({ title: 'Titolo', desc: 'Messaggio' })
    // English client, no English text stored: the stored text is shown.
    const [, c] = buildNewsItems({ locale: 'en', canManageTeam: false, announcements: [ann({ title_en: null, message_en: null })] })
    expect(c).toMatchObject({ title: 'Titolo', desc: 'Messaggio' })
  })

  it('colours a warning amber and a success green, and an announcement that cannot be closed has no key', () => {
    const items = buildNewsItems({ locale: 'en', canManageTeam: false, announcements: [ann({ id: 'w', type: 'warning', dismissible: false }), ann({ id: 's', type: 'success' })] })
    expect(items.find(i => i.id === 'announcement-w')).toMatchObject({ tone: 'amber', dismissKey: null })
    expect(items.find(i => i.id === 'announcement-s')).toMatchObject({ tone: 'green' })
  })
})

describe('visibleNewsItems', () => {
  const items = buildNewsItems({
    locale: 'en',
    canManageTeam: true,
    announcements: [{ id: 'x', title: 'T', message: 'M', title_en: null, message_en: null, type: 'warning', dismissible: false }],
  })

  it('shows everything when nothing was closed on this phone', () => {
    expect(visibleNewsItems(items, new Set()).map(i => i.id)).toEqual(['guide-relay-docs', 'team-access', 'announcement-x'])
  })

  it('drops what was closed, but never an announcement that cannot be closed', () => {
    const closed = new Set([GUIDE_DISMISS_KEY, TEAM_DISMISS_KEY, 'anything-else'])
    expect(visibleNewsItems(items, closed).map(i => i.id)).toEqual(['announcement-x'])
  })

  it('is empty (so the round button disappears) once everything closable is closed and nothing permanent exists', () => {
    const only = buildNewsItems({ locale: 'en', canManageTeam: false, announcements: [] })
    expect(visibleNewsItems(only, new Set([GUIDE_DISMISS_KEY]))).toEqual([])
  })
})

describe('the floating banner', () => {
  const ann = (over: Partial<NewsAnnouncementRow> = {}): NewsAnnouncementRow => ({
    id: 'a1', title: 'Titolo', message: 'Messaggio', title_en: 'Title', message_en: 'Message', type: 'info', dismissible: true, ...over,
  })
  const all = buildNewsItems({ locale: 'en', canManageTeam: true, announcements: [ann(), ann({ id: 'a2', dismissible: false })] })
  const none = new Set<string>()

  it('only a team-written announcement can pop up: never the Relay guide or the team-invite card', () => {
    expect(all.filter(isTeamAnnouncement).map(i => i.id)).toEqual(['announcement-a1', 'announcement-a2'])
    expect(bannerItems(all, none, none).map(i => i.id)).toEqual(['announcement-a1', 'announcement-a2'])
    expect(bannerItems(buildNewsItems({ locale: 'en', canManageTeam: true, announcements: [] }), none, none)).toEqual([])
  })

  it('closing the banner hides it, but the announcement stays under the News button', () => {
    const [first] = all.filter(isTeamAnnouncement)
    const seen = new Set([bannerKeyFor(first)])
    expect(bannerItems(all, none, seen).map(i => i.id)).toEqual(['announcement-a2'])
    expect(visibleNewsItems(all, none).map(i => i.id)).toContain('announcement-a1')
  })

  it('an announcement the client already closed under News never pops up as a banner', () => {
    const closed = new Set([`${ANNOUNCEMENT_DISMISS_PREFIX}a1`])
    expect(bannerItems(all, closed, none).map(i => i.id)).toEqual(['announcement-a2'])
  })

  it('an announcement that cannot be closed still has a banner that can be closed', () => {
    const seen = new Set([bannerKeyFor(all.find(i => i.id === 'announcement-a2') as (typeof all)[number])])
    expect(bannerItems(all, none, seen).map(i => i.id)).toEqual(['announcement-a1'])
  })

  it('remembers the banner under its own key, so it can never clash with the News "closed" key', () => {
    const key = bannerKeyFor(all.filter(isTeamAnnouncement)[0])
    expect(key).toBe(`${BANNER_DISMISS_PREFIX}announcement-a1`)
    expect(key).not.toBe(`${ANNOUNCEMENT_DISMISS_PREFIX}a1`)
    expect(key.startsWith(BANNER_DISMISS_PREFIX)).toBe(true)
  })
})

describe('the News button keeps what the client already read ("Earlier")', () => {
  const ann = (over: Partial<NewsAnnouncementRow> = {}): NewsAnnouncementRow => ({
    id: 'a1', title: 'Titolo', message: 'Messaggio', title_en: 'Title', message_en: 'Message', type: 'info', dismissible: true, ...over,
  })
  const all = buildNewsItems({ locale: 'en', canManageTeam: true, announcements: [ann(), ann({ id: 'a2', dismissible: false })] })

  it('nothing closed yet: nothing is "earlier"', () => {
    expect(earlierNewsItems(all, new Set())).toEqual([])
  })

  it('a closed announcement moves from the open list to "earlier", and is still listed (so the client can read it again)', () => {
    const closed = new Set([`${ANNOUNCEMENT_DISMISS_PREFIX}a1`])
    expect(earlierNewsItems(all, closed).map(i => i.id)).toEqual(['announcement-a1'])
    expect(visibleNewsItems(all, closed).map(i => i.id)).not.toContain('announcement-a1')
  })

  it('an announcement that cannot be closed is never "earlier": it is always open', () => {
    const closed = new Set([`${ANNOUNCEMENT_DISMISS_PREFIX}a2`])
    expect(earlierNewsItems(all, closed)).toEqual([])
    expect(visibleNewsItems(all, closed).map(i => i.id)).toContain('announcement-a2')
  })

  it('open + earlier always add up to every announcement (none is lost, none is listed twice)', () => {
    const closed = new Set([GUIDE_DISMISS_KEY, `${ANNOUNCEMENT_DISMISS_PREFIX}a1`])
    const open = visibleNewsItems(all, closed).map(i => i.id)
    const earlier = earlierNewsItems(all, closed).map(i => i.id)
    expect([...open, ...earlier].sort()).toEqual(all.map(i => i.id).sort())
    expect(open.filter(id => earlier.includes(id))).toEqual([])
  })
})
