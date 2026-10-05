'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MoreVertical, ExternalLink, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { absoluteNavUrl, isInternalNavHref } from '@/lib/nav/nav-link'
import { cn } from '@/lib/utils'

/**
 * The ⋯ button on every left-menu item (dev job f3f3e237, step 1).
 *
 * Two actions, the same on every page: "Open in new tab" and "Copy link".
 * Antonio's decisions (2026-10-05): the button goes on EVERY item; the browser's
 * own right-click is left alone.
 *
 * HOW IT STAYS SAFE (council round 3, senior engineer + bug hunter):
 * - It is a SIBLING of the item's <Link>, never inside it — a button inside an
 *   anchor would navigate away when clicked.
 * - The menu is portalled to <body>, so the narrow, scrollable sidebar can't
 *   clip it, and it sits above the mobile drawer (z-[70]).
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
}) {
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
    <DropdownMenu.Root>
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
          className="z-[70] min-w-[180px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
