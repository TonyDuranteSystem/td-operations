'use client'

import Link from 'next/link'
import type { TeamNotifItem } from '@/lib/team/workspace'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { isWindowOpenClick } from '@/lib/windows/open-intent'
import { isWindowableUrl } from '@/lib/windows/window-model'
import { canOpenWindowNow, requestOpenWindow, useWindowsAvailable } from '@/lib/windows/windows-context'
import { NavItemMenu, type MoveMenu } from '@/components/dashboard/nav-item-menu'

export interface NavItem {
  id: string
  name: string
  href: string
  icon: React.ElementType
  badge?: number
  /** Presence dot (no number) — Team Chat shows this for a new DM / @mention. */
  dotBadge?: boolean
  /** Secondary purple badge — used for the Portal Chats "What's New" unhandled count. */
  purpleBadge?: number
  /** Two rows that show the SAME number share a key, so a group holding both counts it once in its total. */
  badgeKey?: string
  adminOnly?: boolean
  /**
   * Visible ONLY to the code-level owner account. Stricter than adminOnly, and
   * needed wherever the destination's own guard is isOwnerOnly: an item shown to
   * a wider audience than the page admits is a silent dead link — the visitor is
   * redirected home with no explanation, which is exactly what "My Finances" did
   * to every admin between 2026-08-29 and 2026-08-30.
   */
  ownerOnly?: boolean
  featureFlag?: string
  tooltip?: string
}

/**
 * One page in the left menu (main list, group flyout or phone drawer — they all use THIS row, so anything added here reaches
 * every page wherever the person has put it). The ⋯ button is a SIBLING of the link, never inside it.
 */
export function NavItemRow({ item, isActive, onMobileClose, move, onMenuOpenChange }: {
  item: NavItem
  isActive: boolean
  onMobileClose: () => void
  /** "Move to…" in the ⋯ menu: where this page lives now and what the person can do with it. */
  move?: MoveMenu
  /** Tells a flyout that one of this row's menus is open, so the flyout stays put while it is. */
  onMenuOpenChange?: (open: boolean) => void
}) {
  // ⋯ placement (dev job f3f3e237 step 1, QA fix 2026-10-05): on a screen with a mouse the
  // button OVERLAYS the right end of the row on hover (and the count badges there step
  // aside), so it never costs the name any width — a reserved slot made "Portal Chats"
  // and "TD Communication" shorten to "Portal ..." even with nothing hovered. Touch screens
  // have no hover, so there the button keeps its own slot. The Team Chat dot is itself
  // clickable and sits at that same edge, so a row with the dot keeps the slot everywhere.
  const windowsAvailable = useWindowsAvailable()
  const overlay = !item.dotBadge
  // visibility (not opacity): the red badge pulses, and an animation overrides opacity.
  const badgeStepAside = overlay
    ? '[@media(hover:hover)]:group-hover:invisible [@media(hover:hover)]:group-focus-within:invisible [@media(hover:hover)]:group-has-[[data-state=open]]:invisible'
    : ''

  return (
    <div draggable={false} className="group relative flex items-center rounded-md transition-colors select-none">
      <Link
        href={item.href}
        onClick={e => {
          // Option/Alt-click opens the page as a floating window (step 6) — only when windows are on;
          // Cmd/Ctrl-click and Shift-click stay the browser's own (new tab / new window).
          if (canOpenWindowNow(windowsAvailable) && isWindowOpenClick(e) && isWindowableUrl(item.href)) {
            e.preventDefault()
            requestOpenWindow(item.href, item.name)
          }
          onMobileClose()
        }}
        title={item.tooltip}
        className={cn(
          'flex-1 min-w-0 flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        )}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 min-w-0 truncate">{item.name}</span>
        {item.badge != null && item.badge > 0 && (
          <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-500 text-white min-w-[20px] text-center animate-pulse', badgeStepAside)}>
            {item.badge > 999 ? '999+' : item.badge}
          </span>
        )}
        {item.purpleBadge != null && item.purpleBadge > 0 && (
          <span
            className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500 text-white min-w-[20px] text-center', badgeStepAside)}
            title="What's New — unhandled client actions"
          >
            {item.purpleBadge > 999 ? '999+' : item.purpleBadge}
          </span>
        )}
      </Link>
      {item.dotBadge && <TeamNotifDot onNavigate={onMobileClose} only={item.id === 'td-talk' ? 'talk' : undefined} />}
      {/* ⋯ menu (dev job f3f3e237 step 1): a SIBLING of the Link, placed last so it never sits on top of the count badges or the Team Chat dot. */}
      <NavItemMenu href={item.href} name={item.name} onNavigate={onMobileClose} overlay={overlay} move={move} onOpenChange={onMenuOpenChange} />
    </div>
  )
}

/**
 * The clickable Team Chat notification dot: a red dot that, on click, pops a
 * small list of the user's unread DMs + @mentions (each deep-linked) so they can
 * triage priority without opening Team Chat. Fixed-positioned popover (measured
 * off the dot) so the narrow scrollable sidebar can't clip it.
 */
export function TeamNotifDot({ onNavigate, only }: { onNavigate?: () => void; /** 'talk' = the TD Talk tab's dot: only DMs and groups, each linking into the tab. */ only?: 'talk' }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<TeamNotifItem[] | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 60, top: 100 })
  const btnRef = useRef<HTMLButtonElement>(null)

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const next = !open
    setOpen(next)
    if (next) {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setPos({ left: r.right + 8, top: r.top - 4 })
      setItems(null)
      fetch('/api/team/notifications')
        .then(res => res.json())
        .then(d => {
          const all: TeamNotifItem[] = Array.isArray(d.items) ? d.items : []
          setItems(only === 'talk'
            ? all.filter(i => i.kind === 'dm' || i.kind === 'group').map(i => ({ ...i, url: i.url.replace('/team-chat', '/td-talk') }))
            : all)
        })
        .catch(() => setItems([]))
    }
  }

  return (
    <span className="shrink-0 flex items-center">
      <FastTooltip label="New — click to see what">
        <button
          ref={btnRef}
          onClick={toggle}
          className="w-2.5 h-2.5 mr-1 rounded-full bg-red-500 animate-pulse"
          aria-label={only === 'talk' ? 'TD Talk notifications' : 'Team chat notifications'}
        />
      </FastTooltip>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={toggle} />
          <div
            className="fixed z-50 w-60 max-w-[80vw] bg-white rounded-lg shadow-xl border border-zinc-200 py-1 cursor-default"
            style={{ left: pos.left, top: pos.top }}
            onClick={e => e.stopPropagation()}
          >
            <p className="px-3 py-1.5 text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">New for you</p>
            {items === null && <p className="px-3 py-2 text-xs text-zinc-400">Loading…</p>}
            {items !== null && items.length === 0 && <p className="px-3 py-2 text-xs text-zinc-400">Nothing new.</p>}
            {items?.map(it => (
              <Link
                key={it.id}
                href={it.url}
                onClick={() => { setOpen(false); onNavigate?.() }}
                className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-50"
              >
                <span className={cn(
                  'text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0',
                  it.kind === 'dm' ? 'bg-blue-100 text-blue-700'
                    : it.kind === 'conversation' ? 'bg-emerald-100 text-emerald-700'
                    : it.kind === 'thread' ? 'bg-sky-100 text-sky-700'
                    : 'bg-violet-100 text-violet-700',
                )}>
                  {it.kind === 'dm' ? 'DM' : it.kind === 'group' ? 'Group' : it.kind === 'conversation' ? 'Client' : it.kind === 'thread' ? 'Thread' : '@'}
                </span>
                <span className="flex-1 truncate text-sm text-zinc-800">{it.label}</span>
                {it.count > 1 && <span className="text-[10px] text-zinc-400 shrink-0">{it.count}</span>}
              </Link>
            ))}
          </div>
        </>
      )}
    </span>
  )
}
