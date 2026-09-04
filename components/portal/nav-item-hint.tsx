'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/portal/use-locale'

const DISMISS_KEY_PREFIX = 'td-nav-hint-dismissed-'
const POPOVER_W = 260

/**
 * Small "what is this section for" info affordance for one sidebar nav item.
 * Requested by Antonio (2026-09-03): hovering a menu item should explain what
 * it's for and what the client can do there; the client can hide that hint,
 * after which a small "i" stays behind so they can bring it back on demand.
 *
 * Rebuilt (council review, 2026-09-04) to mirror components/help/help-dot.tsx's
 * established pattern — anchored next to the trigger icon via
 * getBoundingClientRect + a <body> portal, closed on outside click / Escape /
 * scroll / resize — instead of the original full-screen centered modal, which
 * had two real bugs: dismissing it by tapping the backdrop also navigated the
 * client (the click bubbled through React's tree to the parent nav <Link>,
 * since the backdrop sat between them), and once a hint had been dismissed
 * once there was no way to close it again by keyboard (no Escape handler, no
 * "Got it" button post-dismissal, and the backdrop wasn't keyboard-operable).
 * Anchoring next to the icon also makes it obvious which control the text is
 * about, which the centered version didn't.
 *
 * `getBoundingClientRect()` always reports true viewport coordinates even
 * inside a transformed ancestor (the sidebar carries an active CSS transform
 * during its mobile slide-in animation) — only a `position: fixed` element
 * actually NESTED inside that ancestor breaks, which is why the popover is
 * still portaled straight to <body>.
 *
 * Mouse hover only auto-opens it, and only before the client has dismissed it
 * once — gated on real hover capability (`hover: hover` + `pointer: fine`),
 * the same guard fast-tooltip.tsx uses, for the same reason: a plain CSS
 * hover trigger also fires on a phone tap in many mobile browsers with no
 * matching "leave" event, leaving the popover stuck open (found live on that
 * exact component during a past council review, dev job 06e57270). Touch
 * clients never get an automatic reveal either way — the icon is always
 * tappable, which is the only affordance they need. Deliberately no
 * close-on-mouse-leave: the "Got it" button lives inside the popover, and a
 * hover user moving their cursor down into it would trigger a leave on the
 * trigger button first and close it before the click ever landed.
 *
 * Dismissal is per-item, per-browser (localStorage) — the same lightweight
 * pattern already used for the Team nav item's one-time feature announcement.
 * This is a UI convenience, not account data, so it does not need to be
 * account-wide or synced across devices.
 */
export function NavItemHint({ itemKey, text, label }: { itemKey: string; text: string; label: string }) {
  const { t } = useLocale()
  const [dismissed, setDismissed] = useState(false)
  const [open, setOpen] = useState(false)
  const [canHover, setCanHover] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Read in an effect (not render) to avoid a server/client hydration
  // mismatch — the server has no localStorage to read from.
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY_PREFIX + itemKey) === '1')
    } catch {
      // localStorage unavailable — behave as never-dismissed.
    }
  }, [itemKey])

  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    setCanHover(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setCanHover(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    let left = r.left + r.width / 2 - POPOVER_W / 2
    left = Math.max(8, Math.min(left, window.innerWidth - POPOVER_W - 8))
    setCoords({ top: r.bottom + 6, left })
  }, [])

  const openPopover = useCallback(() => { place(); setOpen(true) }, [place])
  const closePopover = useCallback(() => setOpen(false), [])

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY_PREFIX + itemKey, '1')
    } catch {
      // Best-effort — the popover still closes even if this can't persist.
    }
    setDismissed(true)
    setOpen(false)
  }

  // Close on outside click, Escape, or scroll/resize (fixed position would
  // detach from its anchor otherwise). The outside-click listener is a plain
  // DOM `mousedown` listener, entirely separate from React's synthetic event
  // tree — it can never bubble into the parent nav <Link> the way the old
  // backdrop element could.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          // Stop the click reaching the parent nav <Link> — this icon sits
          // inside the row's link area so the whole row stays one click
          // target for navigation, but tapping the "i" must only open the
          // hint, never also navigate away from it.
          e.preventDefault()
          e.stopPropagation()
          if (canHover) {
            // Found live (council review, 2026-09-04): on a real hover-
            // capable browser, hovering already opens the popover, so a
            // toggle here would immediately close what the hover just
            // opened the moment the click that follows a hover lands.
            // Always (re)open instead — Escape, an outside click, or "Got
            // it" are the close paths on this input type.
            openPopover()
          } else {
            // Touch has no hover affordance, so the icon itself must toggle.
            open ? closePopover() : openPopover()
          }
        }}
        onMouseEnter={() => !dismissed && canHover && openPopover()}
        className={cn(
          'p-1 rounded-full transition-colors focus:outline-none focus:ring-1 focus:ring-zinc-300',
          dismissed
            ? 'text-zinc-300 hover:text-zinc-500 hover:bg-zinc-100'
            : 'text-blue-500 bg-blue-50 hover:bg-blue-100 hover:text-blue-600'
        )}
        aria-label={`${t('nav.hint.ariaLabel')}: ${label}`}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: POPOVER_W, zIndex: 9999 }}
          className="rounded-lg border border-zinc-200 bg-white p-3 text-left shadow-xl"
        >
          <p className="text-xs font-semibold text-zinc-900 mb-1">{label}</p>
          <p className="text-xs leading-relaxed text-zinc-600">{text}</p>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              dismiss()
            }}
            className="mt-2 text-[11px] font-medium text-blue-600 hover:text-blue-800"
          >
            {t('nav.hint.gotIt')}
          </button>
        </div>,
        document.body
      )}
    </span>
  )
}
