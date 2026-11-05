'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef } from 'react'
import { MoreVertical, ExternalLink, Link2, AppWindow, FolderInput, ChevronRight, Check, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { absoluteNavUrl, isInternalNavHref } from '@/lib/nav/nav-link'
import { cn } from '@/lib/utils'
import { isWindowableUrl } from '@/lib/windows/window-model'
import { requestOpenWindow, useWindowsAvailable } from '@/lib/windows/windows-context'

/** "Move to…" in the ⋯ menu (dev job 45aa5872): where the page is now and what the person can do with it. */
export interface MoveMenu {
  /** 'root' = the main list, otherwise the id of the group the page sits in. */
  current: string
  groups: Array<{ id: string; name: string }>
  onMove: (to: string) => void
  onNewGroup: () => void
}

/**
 * The ⋯ button on every left-menu item (dev job f3f3e237, step 1).
 *
 * The same actions on every page: "Open in a window", "Open in new tab", "Copy link" — and (dev job 45aa5872) "Move to…", the
 * easy way to put a page into a group or back in the main list without dragging.
 * Antonio's decisions (2026-10-05): the button goes on EVERY item; the browser's
 * own right-click is left alone.
 *
 * HOW IT STAYS SAFE (council round 3, senior engineer + bug hunter):
 * - It is a SIBLING of the item's <Link>, never inside it — a button inside an
 *   anchor would navigate away when clicked.
 * - The menu is portalled to <body>, so the narrow, scrollable sidebar can't
 *   clip it, and it sits above the mobile drawer (z-[100]).
 * - "Open in new tab" is a real <a target="_blank">, so the browser treats it
 *   as the user's own click (no popup blocker). How an installed (standalone)
 *   app window handles a new tab is UNVERIFIED — see docs/systems/pwa.md.
 * - "Copy link" writes the clipboard synchronously inside the click, with an
 *   honest then/catch (same pattern as portal-chats' copyDeepLink): never a
 *   false "Copied".
 * - Visible on hover and keyboard focus; ALWAYS visible on touch screens (no
 *   hover there). The caller does not render it in reorder mode.
 */
export function NavItemMenu({
  href,
  name,
  onNavigate,
  overlay = false,
  move,
  onOpenChange,
}: {
  href: string
  name: string
  /** Closes the mobile drawer after a choice. */
  onNavigate?: () => void
  /**
   * On a screen with a mouse, float over the row's right end instead of taking a slot
   * of its own, so it costs the item name no width. Touch screens (no hover) always
   * keep a slot. The caller turns this off for a row whose right edge is already taken
   * by a clickable control (the Team Chat dot).
   */
  overlay?: boolean
  /** Adds "Move to…" (left out in places that cannot move pages). */
  move?: MoveMenu
  /** Lets a group flyout stay open while this menu is open. */
  onOpenChange?: (open: boolean) => void
}) {
  // Floating windows (step 5/6): only when the admin switch is on, and only for a real CRM page.
  const windowsAvailable = useWindowsAvailable()
  // "New group…" opens a name box: Radix would hand focus back to the ⋯ button as the menu closes and steal it from the box.
  const keepFocus = useRef(false)
  // A menu item pointing at anything but a normal CRM page path gets no menu.
  if (!isInternalNavHref(href)) return null

  const copyLink = () => {
    const url = absoluteNavUrl(window.location.origin, href)
    if (!url) {
      toast.error('Could not build the link for this page.')
      return
    }
    if (!navigator.clipboard?.writeText) {
      toast.error('Could not copy the link on this device.')
      return
    }
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('Link copied.'))
      .catch(() => toast.error('Could not copy the link on this device.'))
  }

  const itemClass =
    'flex items-center gap-2 px-3 py-2 text-sm text-zinc-800 cursor-pointer outline-none hover:bg-zinc-50 focus:bg-zinc-50'

  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${name}`}
          className={cn(
            'mr-1 flex h-7 w-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
            overlay &&
              '[@media(hover:hover)]:absolute [@media(hover:hover)]:right-1 [@media(hover:hover)]:top-1/2 [@media(hover:hover)]:mr-0 [@media(hover:hover)]:-translate-y-1/2',
          )}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={6}
          className="z-[100] min-w-[180px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
          onCloseAutoFocus={e => {
            if (keepFocus.current) {
              e.preventDefault()
              keepFocus.current = false
            }
          }}
        >
          {windowsAvailable && isWindowableUrl(href) && (
            // Desktop only: a window is a frame over the page, which makes no sense on a phone.
            <DropdownMenu.Item
              className={cn(itemClass, 'hidden lg:flex')}
              onSelect={() => {
                requestOpenWindow(href, name)
                onNavigate?.()
              }}
            >
              <AppWindow className="h-3.5 w-3.5 text-zinc-500" />
              Open in a window
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item asChild onSelect={() => onNavigate?.()}>
            <a href={href} target="_blank" rel="noopener noreferrer" className={itemClass}>
              <ExternalLink className="h-3.5 w-3.5 text-zinc-500" />
              Open in new tab
            </a>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={itemClass}
            onSelect={() => {
              copyLink()
              onNavigate?.()
            }}
          >
            <Link2 className="h-3.5 w-3.5 text-zinc-500" />
            Copy link
          </DropdownMenu.Item>
          {move && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className={cn(itemClass, 'justify-between data-[state=open]:bg-zinc-50')}>
                  <span className="flex items-center gap-2">
                    <FolderInput className="h-3.5 w-3.5 text-zinc-500" />
                    Move to…
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    sideOffset={4}
                    className="z-[100] min-w-[170px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
                  >
                    {move.groups.map(g => (
                      <DropdownMenu.Item
                        key={g.id}
                        disabled={move.current === g.id}
                        className={cn(itemClass, 'justify-between data-[disabled]:cursor-default data-[disabled]:text-zinc-400')}
                        onSelect={() => move.onMove(g.id)}
                      >
                        <span className="truncate">{g.name}</span>
                        {move.current === g.id && <Check className="h-3.5 w-3.5 shrink-0" />}
                      </DropdownMenu.Item>
                    ))}
                    <DropdownMenu.Item
                      disabled={move.current === 'root'}
                      className={cn(itemClass, 'justify-between data-[disabled]:cursor-default data-[disabled]:text-zinc-400')}
                      onSelect={() => move.onMove('root')}
                    >
                      <span>Main list</span>
                      {move.current === 'root' && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-zinc-100" />
                    <DropdownMenu.Item
                      className={itemClass}
                      onSelect={() => {
                        keepFocus.current = true
                        move.onNewGroup()
                      }}
                    >
                      <Plus className="h-3.5 w-3.5 text-zinc-500" />
                      New group…
                    </DropdownMenu.Item>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
