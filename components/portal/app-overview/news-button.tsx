'use client'

// Client iPhone app, Overview redesign (dev job 056a70d0): the round News button in the corner of the company card.
// Every announcement (Relay guide, team-invite, the ones the team writes in the CRM) lives behind this one button instead of being a big
// card at the top of the screen. A red number says how many are still open on this phone; tapping it opens them in a sheet. The button is
// ALWAYS there: when every announcement is closed the number goes away and the sheet lists them under "Earlier", so the client can read the
// news again. "Closed" is remembered on the phone (the same keys the website's banners use).
// It also owns the floating banner: a team-written announcement the client has not been shown yet pops up above the bottom bar (see news.ts).
import { useCallback, useEffect, useState } from 'react'
import { Globe, Megaphone, Users, type LucideIcon } from 'lucide-react'
import { BottomSheet } from '@/components/app-mode/bottom-sheet'
import { AppAnnouncementCard } from '@/components/portal/app-announcement-card'
import { useLocale } from '@/lib/portal/use-locale'
import { bannerItems, bannerKeyFor, earlierNewsItems, isTeamAnnouncement, visibleNewsItems, type NewsIcon, type NewsItem } from '@/lib/portal-app/news'
import { AppNewsBanner } from './news-banner'

const ICONS: Record<NewsIcon, LucideIcon> = { globe: Globe, users: Users, megaphone: Megaphone }

function readClosed(items: NewsItem[]): Set<string> {
  const closed = new Set<string>()
  for (const item of items) {
    if (!item.dismissKey) continue
    try {
      if (localStorage.getItem(item.dismissKey)) closed.add(item.dismissKey)
    } catch {
      // storage unavailable: the announcement counts as open
    }
  }
  return closed
}

/** Which announcements' banners this phone has already shown and closed. */
function readBannerSeen(items: NewsItem[]): Set<string> {
  const seen = new Set<string>()
  for (const item of items) {
    if (!isTeamAnnouncement(item)) continue
    try {
      if (localStorage.getItem(bannerKeyFor(item))) seen.add(bannerKeyFor(item))
    } catch {
      // storage unavailable: the banner shows (it is closed for this visit only)
    }
  }
  return seen
}

function remember(key: string) {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // no-op: it will show again next time
  }
}

/**
 * Banners the client put away with "Later" during this visit. Kept in memory on purpose (not on the phone): it lasts until the app is
 * opened again, so a banner that was not read comes back, and it survives moving between screens inside the app.
 */
const putAwayForNow = new Set<string>()

export function AppNewsButton({ items }: { items: NewsItem[] }) {
  const { t } = useLocale()
  // null until this phone's storage has been read, so nothing flashes in and out.
  const [closed, setClosed] = useState<Set<string> | null>(null)
  const [bannerSeen, setBannerSeen] = useState<Set<string> | null>(null)
  const [later, setLater] = useState<Set<string>>(() => new Set(putAwayForNow))
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setClosed(readClosed(items))
    setBannerSeen(readBannerSeen(items))
  }, [items])

  const close = useCallback((key: string) => {
    remember(key)
    setClosed(prev => new Set(prev ?? []).add(key))
  }, [])

  const visible = closed ? visibleNewsItems(items, closed) : []
  const earlier = closed ? earlierNewsItems(items, closed) : []
  // Every banner not read yet, and the ones of them still showing (the client has not chosen "Later" on them this visit).
  const unreadBanners = closed && bannerSeen ? bannerItems(items, closed, bannerSeen) : []
  const banner = unreadBanners.filter(i => !later.has(bannerKeyFor(i)))

  // Reading the news (the banner tapped, or the News button opened) is remembered per announcement, so its banner never comes back
  // (also one the client had put away with "Later" earlier in the visit).
  const markBannerRead = () => {
    for (const i of unreadBanners) remember(bannerKeyFor(i))
    setBannerSeen(prev => {
      const next = new Set(prev ?? [])
      for (const i of unreadBanners) next.add(bannerKeyFor(i))
      return next
    })
  }
  // "Later" (or a swipe down) puts the banner away for this visit only; it is not remembered on the phone.
  const putBannerAway = () => {
    for (const i of banner) putAwayForNow.add(bannerKeyFor(i))
    setLater(prev => {
      const next = new Set(prev)
      for (const i of banner) next.add(bannerKeyFor(i))
      return next
    })
  }
  const openSheet = () => {
    markBannerRead()
    setOpen(true)
  }
  // Nothing at all to show (only possible before this phone's storage was read): no button.
  if (visible.length === 0 && earlier.length === 0) return null

  const closable = visible.filter(i => i.dismissKey !== null)
  const markAll = () => {
    for (const i of closable) if (i.dismissKey) remember(i.dismissKey)
    setClosed(prev => {
      const next = new Set(prev ?? [])
      for (const i of closable) if (i.dismissKey) next.add(i.dismissKey)
      return next
    })
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        data-testid="app-news-button"
        aria-label={visible.length > 0 ? `${t('app.overview.news')} (${visible.length})` : t('app.overview.news')}
        onClick={openSheet}
        className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/35 bg-white/20 text-white"
      >
        <Megaphone className="h-5 w-5" aria-hidden="true" />
        {visible.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-blue-700 bg-red-500 px-1 text-xs font-bold leading-none text-white">
            {visible.length}
          </span>
        )}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t('app.overview.news')} closeLabel={t('app.overview.close')}>
        <div data-testid="app-news-sheet" className="space-y-3 px-4 pb-3 pt-1">
          {visible.length === 0 && (
            <p data-testid="app-news-all-read" className="px-1 text-sm text-zinc-600">{t('app.overview.allRead')}</p>
          )}
          {visible.map(item => (
            <AppAnnouncementCard
              key={item.id}
              tone={item.tone}
              icon={ICONS[item.icon]}
              title={item.title}
              desc={item.desc}
              cta={item.cta}
              href={item.href}
              dismissLabel={item.dismissLabel}
              onDismiss={item.dismissKey ? () => close(item.dismissKey as string) : null}
              onNavigate={() => setOpen(false)}
            />
          ))}
          {closable.length > 0 && (
            <button type="button" onClick={markAll} className="mx-auto block px-4 text-sm font-semibold text-blue-600">
              {t('app.overview.markAllRead')}
            </button>
          )}
          {earlier.length > 0 && (
            <div data-testid="app-news-earlier" className="space-y-3 pt-1">
              <p className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{t('app.overview.earlier')}</p>
              {earlier.map(item => (
                <div key={item.id} className="opacity-80">
                  <AppAnnouncementCard
                    tone={item.tone}
                    icon={ICONS[item.icon]}
                    title={item.title}
                    desc={item.desc}
                    cta={item.cta}
                    href={item.href}
                    dismissLabel={item.dismissLabel}
                    onDismiss={null}
                    onNavigate={() => setOpen(false)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </BottomSheet>
      {banner.length > 0 && !open && (
        <AppNewsBanner
          title={banner.length === 1 ? banner[0].title : t('app.overview.bannerMany').replace('{n}', String(banner.length))}
          hint={t('app.overview.bannerTap')}
          laterLabel={t('app.overview.later')}
          onOpen={openSheet}
          onLater={putBannerAway}
        />
      )}
    </>
  )
}
