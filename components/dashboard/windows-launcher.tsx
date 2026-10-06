'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect, useState } from 'react'
import { AppWindow, HelpCircle, MessageSquare } from 'lucide-react'
import { isWindowableUrl } from '@/lib/windows/window-model'
import { openWindowsFeedback, requestOpenWindow, startWindowsTour, useWindowsAvailable } from '@/lib/windows/windows-context'

export interface LauncherItem {
  id: string
  name: string
  href: string
  icon: React.ElementType
}

/**
 * "Windows" in the left menu's footer (dev job f3f3e237, step 6): one list of pages you can open as
 * a floating window from anywhere.
 *
 * The list is NOT built here: the sidebar passes the very array it renders as the menu (already
 * filtered for admin-only, owner-only and feature-flagged pages), so a person can never launch a page
 * the menu would not show them. Desktop only, and only while the admin switch is on.
 */
const NEW_SINCE_KEY = 'td-windows-new-since'
const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000

export function WindowsLauncher({ items }: { items: LauncherItem[] }) {
  const available = useWindowsAvailable()
  // A small NEW tag for the first 30 days this browser has seen the button (same idea as the AI Agent tag).
  const [showNew, setShowNew] = useState(false)
  useEffect(() => {
    if (!available) return
    try {
      const raw = window.localStorage.getItem(NEW_SINCE_KEY)
      const since = raw ? Number(raw) : Date.now()
      if (!raw) window.localStorage.setItem(NEW_SINCE_KEY, String(since))
      setShowNew(Number.isFinite(since) && Date.now() - since < NEW_FOR_MS)
    } catch {
      setShowNew(false)
    }
  }, [available])
  if (!available) return null
  const pages = items.filter(i => isWindowableUrl(i.href))
  if (pages.length === 0) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-tour="win-launcher"
          className="hidden w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:flex"
        >
          <AppWindow className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Open in a window</span>
          {showNew && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300">NEW</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-[70] max-h-[min(70vh,32rem)] min-w-[220px] overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 border-b border-zinc-100 px-3 py-2 text-sm font-medium text-emerald-800 outline-none hover:bg-emerald-50 focus:bg-emerald-50"
            onSelect={() => startWindowsTour()}
          >
            <HelpCircle className="h-3.5 w-3.5" />
            Take the 1-minute tour
          </DropdownMenu.Item>
          <DropdownMenu.Label className="px-3 py-1.5 text-xs text-zinc-500">
            Opens as a window on top of your page. Tip: hold Option (Alt on Windows) and click any menu item.
          </DropdownMenu.Label>
          {pages.map(p => (
            <DropdownMenu.Item
              key={p.id}
              className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-zinc-800 outline-none hover:bg-zinc-50 focus:bg-zinc-50"
              onSelect={() => requestOpenWindow(p.href, p.name)}
            >
              <p.icon className="h-3.5 w-3.5 text-zinc-500" />
              {p.name}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 border-t border-zinc-100 px-3 py-2 text-xs text-zinc-600 outline-none hover:bg-zinc-50 focus:bg-zinc-50"
            onSelect={() => openWindowsFeedback()}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Tell us what&apos;s off with windows
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
