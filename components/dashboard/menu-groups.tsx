'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calculator, ChevronDown, ChevronRight, Folder, MessageCircleMore, Network } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NavItemRow, type NavItem } from '@/components/dashboard/nav-item-row'
import type { MoveMenu } from '@/components/dashboard/nav-item-menu'

/**
 * Groups in the left menu (dev job 45aa5872, Antonio 2026-11-04: "when I pass on it with the pointer another submenu will open
 * on the right").
 *
 * - Computer with a mouse (wide screen + hover): pointing at a group row opens a panel to its right; a click keeps it open until
 *   you click elsewhere or press Esc. A short grace delay lets the pointer cross the gap without the panel closing.
 * - Phone / narrow window / touch: there is no hover, so tapping the row expands the pages under it, in place.
 * - The group row carries the SUM of its pages' red numbers (and the violet What's New number, and a dot when a page has one),
 *   because the pages themselves are hidden until it is open.
 * The panel sits above the red Supabase incident bar (z-[95]); the ⋯ menu (z-[100]) sits above the panel.
 * Every page inside is the very same row as in the main list (`NavItemRow`), so its ⋯ menu, badges and Option-click work unchanged.
 */

// Server pages render this too; a layout effect there only produces a warning, so fall back to a plain effect.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

const GROUP_ICONS: Record<string, React.ElementType> = {
  'g-social': MessageCircleMore,
  'g-accounting': Calculator,
  'g-network': Network,
}
export const groupIcon = (id: string): React.ElementType => GROUP_ICONS[id] ?? Folder

/** True on a computer with a mouse (wide screen + real hover); null until the browser has answered (render collapsed until then). */
export function useFlyoutMode(): boolean | null {
  const [mode, setMode] = useState<boolean | null>(null)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px) and (hover: hover)')
    const set = () => setMode(mq.matches)
    set()
    mq.addEventListener('change', set)
    return () => mq.removeEventListener('change', set)
  }, [])
  return mode
}

export interface FlyoutController {
  openId: string | null
  show: (id: string) => void
  toggle: (id: string) => void
  scheduleClose: () => void
  cancelClose: () => void
  close: () => void
  /** A menu inside the panel is open: keep the panel where it is. */
  hold: (on: boolean) => void
  /** Close unless a menu inside the panel is open (used when keyboard focus leaves the panel). */
  closeIfIdle: () => void
}

const CLOSE_DELAY_MS = 220

/** One panel open at a time; hover opens it, a click pins it. */
export function useFlyoutController(): FlyoutController {
  const [openId, setOpenId] = useState<string | null>(null)
  const pinned = useRef(false)
  const holds = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
  }, [])
  const close = useCallback(() => {
    cancelClose()
    pinned.current = false
    holds.current = 0
    setOpenId(null)
  }, [cancelClose])
  const show = useCallback((id: string) => {
    cancelClose()
    setOpenId(cur => {
      if (cur !== id) pinned.current = false
      return id
    })
  }, [cancelClose])
  const toggle = useCallback((id: string) => {
    cancelClose()
    setOpenId(cur => {
      if (cur === id && pinned.current) { pinned.current = false; return null }
      pinned.current = true
      return id
    })
  }, [cancelClose])
  const scheduleClose = useCallback(() => {
    cancelClose()
    if (pinned.current || holds.current > 0) return
    timer.current = setTimeout(() => setOpenId(null), CLOSE_DELAY_MS)
  }, [cancelClose])
  const closeIfIdle = useCallback(() => { if (holds.current === 0) close() }, [close])
  const hold = useCallback((on: boolean) => {
    holds.current = Math.max(0, holds.current + (on ? 1 : -1))
    // When the last menu closes the panel may go too — but not while the pointer is still on it (mouseenter will not fire again).
    if (!on && holds.current === 0 && !pinned.current && !document.querySelector('[data-flyout]:hover')) scheduleClose()
  }, [scheduleClose])

  // Click elsewhere, Esc, resize or scrolling the page closes it. A menu open inside the panel is part of the panel.
  useEffect(() => {
    if (!openId) return
    const down = (e: PointerEvent) => {
      if (holds.current > 0) return
      if ((e.target as Element | null)?.closest?.('[data-flyout]')) return
      close()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && holds.current === 0) close() }
    // scrolling the page closes the panel — but not under a ⋯ menu that is open (that menu is part of the panel)
    const scroll = (e: Event) => { if (holds.current === 0 && !(e.target as Element | null)?.closest?.('[data-flyout]')) close() }
    document.addEventListener('pointerdown', down, true)
    // capture phase: it must look BEFORE the open ⋯ menu handles the same Esc (that menu releases its hold, and a later look would see none)
    document.addEventListener('keydown', key, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
    }
  }, [openId, close])
  useEffect(() => cancelClose, [cancelClose])

  return { openId, show, toggle, scheduleClose, cancelClose, close, hold, closeIfIdle }
}

export function GroupRow({ group, items, isActive, onMobileClose, moveFor, flyoutMode, ctl }: {
  group: { id: string; name: string; empty: boolean }
  /** The pages in this group that this person can see, with their live red numbers applied. */
  items: NavItem[]
  isActive: (item: NavItem) => boolean
  onMobileClose: () => void
  moveFor: (item: NavItem) => MoveMenu | undefined
  flyoutMode: boolean | null
  ctl: FlyoutController
}) {
  const Icon = groupIcon(group.id)
  const rowRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const focusFirst = useRef(false)
  const [expanded, setExpanded] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // The panel is mounted INSIDE the shell frame (not on <body>): the sandbox's brown menu colours are set on that frame, and a
  // panel outside it came out grey. The frame has no transform, so `fixed` still means the screen.
  const [host, setHost] = useState<HTMLElement | null>(null)

  // Two rows that show the SAME number (Marketing and Marketing Chat) share a badgeKey and are counted once.
  const sumOnce = (pick: (i: NavItem) => number | undefined) => {
    const seen = new Set<string>()
    let total = 0
    for (const i of items) {
      const n = pick(i) ?? 0
      if (n <= 0) continue
      const key = i.badgeKey ?? i.id
      if (seen.has(key)) continue
      seen.add(key)
      total += n
    }
    return total
  }
  const red = sumOnce(i => i.badge)
  const violet = sumOnce(i => i.purpleBadge)
  // The chat dot (new TD Talk / Team Chat message) shows NEXT TO the numbers: a number is almost always there (email), and it
  // used to hide the dot, so a new message showed nothing until the panel was opened.
  const dot = items.some(i => i.dotBadge)
  const hasActive = items.some(isActive)
  const open = flyoutMode === true && ctl.openId === group.id

  // Phone drawer: the group holding the page you are on opens by itself.
  useEffect(() => {
    if (flyoutMode === false && hasActive) setExpanded(true)
  }, [flyoutMode, hasActive])

  // Panel position: just right of the menu, level with the row, kept on screen.
  useIsoLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const r = rowRef.current?.getBoundingClientRect()
    const aside = rowRef.current?.closest('aside')?.getBoundingClientRect()
    setHost((rowRef.current?.closest('[data-embedded]') as HTMLElement | null) ?? document.body)
    if (r) setPos({ left: (aside?.right ?? r.right) + 4, top: Math.max(8, r.top - 6) })
  }, [open])
  useIsoLayoutEffect(() => {
    if (!open || !pos || !panelRef.current) return
    const maxTop = window.innerHeight - panelRef.current.offsetHeight - 8
    if (pos.top > maxTop) setPos({ left: pos.left, top: Math.max(8, maxTop) })
  }, [open, pos])
  // Opened from the keyboard: move into the panel (it lives at the end of the page, so Tab would never reach it).
  useEffect(() => {
    if (open && pos && focusFirst.current) {
      focusFirst.current = false
      panelRef.current?.querySelector<HTMLElement>('a[href]')?.focus()
    }
  }, [open, pos])

  const badges = (
    <>
      {red > 0 && (
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-500 text-white min-w-[20px] text-center animate-pulse">
          {red > 999 ? '999+' : red}
        </span>
      )}
      {violet > 0 && (
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500 text-white min-w-[20px] text-center" title="What's New — unhandled client actions">
          {violet > 999 ? '999+' : violet}
        </span>
      )}
      {dot && <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" aria-label="New messages" />}
    </>
  )

  const rowClass = cn(
    'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left',
    open || (hasActive && flyoutMode !== false)
      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
  )

  const pageRow = (item: NavItem, afterNavigate: () => void, onMenuOpenChange?: (o: boolean) => void) => (
    <NavItemRow
      key={item.id}
      item={item}
      isActive={isActive(item)}
      onMobileClose={afterNavigate}
      move={moveFor(item)}
      onMenuOpenChange={onMenuOpenChange}
    />
  )

  const empty = (
    <p className="px-3 py-2 text-xs text-sidebar-foreground/50">Empty. Use “Edit menu” (bottom left) or a page’s ⋯ menu → Move to… to add pages.</p>
  )

  // Phone / narrow / touch: expand in place.
  if (flyoutMode !== true) {
    const showChildren = flyoutMode === false && expanded
    return (
      <div>
        <button
          type="button"
          className={cn(rowClass, hasActive && !showChildren && 'bg-sidebar-accent/70')}
          aria-expanded={showChildren}
          onClick={() => setExpanded(v => !v)}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="flex-1 min-w-0 truncate">{group.name}</span>
          {badges}
          {showChildren ? <ChevronDown className="h-4 w-4 shrink-0 opacity-60" /> : <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />}
        </button>
        {showChildren && (
          <div className="ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border pl-2">
            {items.map(item => pageRow(item, onMobileClose))}
            {group.empty && empty}
          </div>
        )}
      </div>
    )
  }

  // Computer: a panel on the right.
  return (
    <div>
      <button
        ref={rowRef}
        type="button"
        data-flyout
        data-testid={`menu-group-${group.id}`}
        className={rowClass}
        aria-expanded={open}
        aria-haspopup="true"
        onMouseEnter={() => ctl.show(group.id)}
        onMouseLeave={ctl.scheduleClose}
        onClick={e => {
          focusFirst.current = e.detail === 0 // 0 = pressed with Enter/Space
          ctl.toggle(group.id)
        }}
        onKeyDown={e => {
          if (e.key === 'ArrowRight') { e.preventDefault(); focusFirst.current = true; ctl.show(group.id) }
        }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 min-w-0 truncate">{group.name}</span>
        {badges}
        <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />
      </button>
      {open && pos && host && createPortal(
        <div
          ref={panelRef}
          data-flyout
          role="group"
          aria-label={group.name}
          data-testid={`menu-flyout-${group.id}`}
          style={{ left: pos.left, top: pos.top }}
          onMouseEnter={ctl.cancelClose}
          onMouseLeave={ctl.scheduleClose}
          onKeyDown={e => {
            // Esc inside an open ⋯ menu closes that menu only: a menu is portalled elsewhere, so it is not inside the panel's DOM.
            if (e.key === 'Escape' && panelRef.current?.contains(e.target as Node)) { ctl.close(); rowRef.current?.focus() }
          }}
          onBlur={e => {
            // Keyboard focus left the panel (Tab out): close it, unless it went to the group row or into a ⋯ menu.
            const to = e.relatedTarget as Node | null
            if (to && (panelRef.current?.contains(to) || rowRef.current?.contains(to))) return
            if (to) ctl.closeIfIdle()
          }}
          className="fixed z-[96] w-64 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-sidebar-border bg-sidebar p-1.5 text-sidebar-foreground shadow-xl space-y-0.5"
        >
          <p className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">{group.name}</p>
          {items.map(item => pageRow(item, () => { ctl.close(); onMobileClose() }, ctl.hold))}
          {group.empty && empty}
        </div>,
        host,
      )}
    </div>
  )
}
