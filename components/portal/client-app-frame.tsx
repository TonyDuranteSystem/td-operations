'use client'

// The frame of a portal page inside the CLIENT iPhone app (dev job 056a70d0, Step 3; docs/systems/client-app.md).
// It replaces the website's side menu and top bar: one slim row at the top of every screen with the company chooser on the Overview
// (or the screen's name where a screen draws it here) on the left, and the round Menu button on the right, with its red number.
// The bottom bar and the Menu list are drawn by the app itself; this button only asks the app to open that list. It exists only inside the app.
import { useEffect, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { Menu } from 'lucide-react'
import { useAppMode } from '@/lib/app-mode/app-mode-context'
import { useLocale } from '@/lib/portal/use-locale'
import { screenTitleFor, type AppMenuItem } from '@/lib/portal-app/frame'

interface ClientBridge { webkit?: { messageHandlers?: { tdclient?: { postMessage: (m: string) => void } } } }

interface MeAnswer { menuBadge?: number; items?: AppMenuItem[] }

export function ClientAppFrame({ selectionQuery, switcher }: { selectionQuery: string; switcher?: ReactNode }) {
  const appMode = useAppMode()
  const pathname = usePathname()
  const tab = useSearchParams()?.get('tab') ?? null
  const { t } = useLocale()
  const [me, setMe] = useState<MeAnswer | null>(null)

  // Tell the app which company this page is showing, so its own bottom bar and Menu list describe THAT company, not the first one (bug hunt
  // 2026-11-10, finding 1: the website's company cookies never reach the app's server doors, so the app has to be told). The app only believes a
  // message from this site's main frame and checks the words before using them (lib: ios/TDClient/Sources/TDClientCore/Rules.swift `SelectionRules`).
  useEffect(() => {
    if (!appMode) return
    ;(window as unknown as ClientBridge).webkit?.messageHandlers?.tdclient?.postMessage(`selection:${selectionQuery}`)
  }, [appMode, selectionQuery])

  // The number on the button and the screen names come from the app's own server answer, so the website's menu rule and the app can
  // never disagree. Asked again on every screen change and whenever the app comes back to the front (the number moves while you read).
  useEffect(() => {
    if (!appMode) return
    let live = true
    const load = () => {
      fetch(`/api/portal/app/me${selectionQuery ? `?${selectionQuery}` : ''}`, { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then((d: MeAnswer | null) => { if (live && d) setMe(d) })
        .catch(() => { /* no number and no screen name; the button still works */ })
    }
    load()
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { live = false; document.removeEventListener('visibilitychange', onVisible) }
  }, [appMode, selectionQuery, pathname])

  if (!appMode) return null
  const badge = Math.max(0, me?.menuBadge ?? 0)
  const title = pathname === '/portal' ? null : screenTitleFor(pathname, me?.items ?? [], tab, { invoices: t('nav.invoices'), billing: t('nav.tdBilling'), chat: t('nav.chat') })
  const label = badge > 0 ? t('app.menuNeedsYou').replace('{n}', String(badge)) : t('app.menu')

  return (
    <div
      data-testid="client-app-frame"
      // Stays at the top of the scrolling page (the Menu is the way to every entry that is not in the bar, so it must never scroll away).
      className="sticky top-0 z-30 flex h-[52px] shrink-0 items-center justify-between gap-3 bg-slate-50/95 px-4 backdrop-blur"
    >
      <div className="min-w-0 flex-1">
        {pathname === '/portal' ? switcher : title ? <span className="block truncate text-[17px] font-semibold text-zinc-900">{title}</span> : null}
      </div>
      <button
        type="button"
        aria-label={label}
        data-testid="client-app-menu"
        onClick={() => (window as unknown as ClientBridge).webkit?.messageHandlers?.tdclient?.postMessage('menu')}
        className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-900"
      >
        <Menu className="h-[22px] w-[22px]" aria-hidden="true" />
        {badge > 0 && (
          <span className="absolute -right-[5px] -top-[5px] flex h-5 min-w-5 items-center justify-center rounded-full bg-[#B91C1C] px-[5px] text-[11.5px] font-bold text-white">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
    </div>
  )
}
