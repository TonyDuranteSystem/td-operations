// Client iPhone app, Overview redesign (dev job 056a70d0): the News button.
//
// On the website the announcements are cards at the top of the home page. Inside the app they all move behind ONE round News button in the
// corner of the company card, so the client's own information is the first thing on the screen. This file holds the part that is not markup:
// which announcements exist, what each one says, and which ones the person has not closed yet. Pure — no browser, no database — so it is
// tested directly. The words of the two built-in announcements live HERE and are used by both the website's cards and the app's sheet, so
// they can never drift apart.

export type NewsTone = 'blue' | 'violet' | 'amber' | 'green'
export type NewsIcon = 'globe' | 'users' | 'megaphone'

export interface NewsItem {
  /** Stable id (the sheet's list key). */
  id: string
  tone: NewsTone
  icon: NewsIcon
  title: string
  desc: string
  /** The button under the words. Null = an announcement with no link (the CRM-written ones have none). */
  cta: string | null
  href: string | null
  /** The localStorage key that remembers "closed" on this device. Null = cannot be closed (counts until the team removes it). */
  dismissKey: string | null
  dismissLabel: string
}

// Bump the version suffix to show a built-in announcement again to everyone after a major change.
export const GUIDE_DISMISS_KEY = 'td-guide-relay-docs-v1'
export const TEAM_DISMISS_KEY = 'td-team-access-announce-v1'
/** The CRM-written announcements remember "closed" under this prefix (the website's banner uses the same key). */
export const ANNOUNCEMENT_DISMISS_PREFIX = 'td-portal-ann-'

export const GUIDE_HREF = '/portal/guide/relay-docs'
export const TEAM_HREF = '/portal/guide'

export const GUIDE_COPY = {
  en: {
    title: 'Relay — International Payments: Document Upload Guide',
    desc: 'See exactly which documents to upload to unlock international wire transfers on your Relay account.',
    cta: 'View Guide',
    dismiss: 'Dismiss',
  },
  it: {
    title: 'Relay — International Payments: Document Upload Guide',
    desc: 'See exactly which documents to upload to unlock international wire transfers on your Relay account.',
    cta: 'View Guide',
    dismiss: 'Dismiss',
  },
}

export const TEAM_COPY = {
  en: {
    title: 'New: Invite your team to the portal',
    desc: 'You can now give your colleagues their own portal login and choose exactly what each of them can see.',
    cta: 'See how it works',
    dismiss: 'Dismiss',
  },
  it: {
    title: 'Novità: Invita il tuo team nel portale',
    desc: 'Ora puoi dare ai tuoi collaboratori un accesso personale al portale e scegliere esattamente cosa ciascuno può vedere.',
    cta: 'Scopri come funziona',
    dismiss: 'Chiudi',
  },
}

/** The shape of a row of the CRM's announcements table (components/portal/announcement-banners.tsx has the same one). */
export interface NewsAnnouncementRow {
  id: string
  title: string
  message: string
  title_en: string | null
  message_en: string | null
  type: 'info' | 'warning' | 'success'
  dismissible: boolean
}

const ANNOUNCEMENT_TONE: Record<NewsAnnouncementRow['type'], NewsTone> = { info: 'blue', warning: 'amber', success: 'green' }

const pick = <T extends object>(copy: { en: T; it: T }, locale: string): T => (locale === 'it' ? copy.it : copy.en)

/**
 * Every announcement the person could see on this company's home page, in the order the website shows them: the Relay guide, the team-invite
 * announcement (only for the people who can invite teammates), then the ones the team wrote in the CRM. Whether each is still OPEN on this
 * device is decided later, by `visibleNewsItems`, because "closed" lives in the phone's own storage.
 */
export function buildNewsItems(input: { locale: string; canManageTeam: boolean; announcements: NewsAnnouncementRow[] }): NewsItem[] {
  const { locale, canManageTeam, announcements } = input
  const g = pick(GUIDE_COPY, locale)
  const items: NewsItem[] = [
    { id: 'guide-relay-docs', tone: 'blue', icon: 'globe', title: g.title, desc: g.desc, cta: g.cta, href: GUIDE_HREF, dismissKey: GUIDE_DISMISS_KEY, dismissLabel: g.dismiss },
  ]
  if (canManageTeam) {
    const t = pick(TEAM_COPY, locale)
    items.push({ id: 'team-access', tone: 'violet', icon: 'users', title: t.title, desc: t.desc, cta: t.cta, href: TEAM_HREF, dismissKey: TEAM_DISMISS_KEY, dismissLabel: t.dismiss })
  }
  for (const a of announcements) {
    // The same rule the website's banner uses: English copy for an English client when it exists, otherwise the stored (Italian) text.
    const title = locale === 'en' && a.title_en ? a.title_en : a.title
    const desc = locale === 'en' && a.message_en ? a.message_en : a.message
    items.push({
      id: `announcement-${a.id}`,
      tone: ANNOUNCEMENT_TONE[a.type] ?? 'blue',
      icon: 'megaphone',
      title,
      desc,
      cta: null,
      href: null,
      dismissKey: a.dismissible ? `${ANNOUNCEMENT_DISMISS_PREFIX}${a.id}` : null,
      dismissLabel: pick(GUIDE_COPY, locale).dismiss,
    })
  }
  return items
}

/** The announcements still open on this device: one that cannot be closed is always open; the others until their key is remembered. */
export function visibleNewsItems(items: NewsItem[], closedKeys: ReadonlySet<string>): NewsItem[] {
  return items.filter(i => i.dismissKey === null || !closedKeys.has(i.dismissKey))
}

// ── The floating banner (app only) ────────────────────────────────────────────────────────────────────────────────────────────────────────
// When the team publishes an announcement, the Overview shows a small floating banner ("tap to read") above the bottom bar until the client
// taps it or closes it. Only the announcements the team wrote in the CRM can pop up: the Relay guide and the team-invite card are always
// "open" for most people, so they stay behind the News button and never nag. Closing the banner is remembered under its OWN key, so it only
// hides the banner; the announcement stays under the News button (with its red number) until the client closes it there.

/** localStorage key prefix that remembers "this announcement's banner was already shown and closed on this phone". */
export const BANNER_DISMISS_PREFIX = 'td-portal-ann-banner-'

/** True for an announcement the team wrote in the CRM (the only kind that may pop up as the banner). */
export function isTeamAnnouncement(item: NewsItem): boolean {
  return item.id.startsWith('announcement-')
}

export function bannerKeyFor(item: NewsItem): string {
  return `${BANNER_DISMISS_PREFIX}${item.id}`
}

/** The announcements that should be in the banner right now: written by the team, still open under the News button, banner not yet closed. */
export function bannerItems(items: NewsItem[], closedKeys: ReadonlySet<string>, bannerSeenKeys: ReadonlySet<string>): NewsItem[] {
  return visibleNewsItems(items, closedKeys).filter(i => isTeamAnnouncement(i) && !bannerSeenKeys.has(bannerKeyFor(i)))
}
