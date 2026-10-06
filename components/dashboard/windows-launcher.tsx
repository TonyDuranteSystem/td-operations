'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { AppWindow } from 'lucide-react'
import { isWindowableUrl } from '@/lib/windows/window-model'
import { requestOpenWindow, useWindowsAvailable } from '@/lib/windows/windows-context'

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
export function WindowsLauncher({ items }: { items: LauncherItem[] }) {
  const available = useWindowsAvailable()
  if (!available) return null
  const pages = items.filter(i => isWindowableUrl(i.href))
  if (pages.length === 0) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="hidden w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:flex"
        >
          <AppWindow className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">Open in a window</span>
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
          <DropdownMenu.Label className="px-3 py-1.5 text-xs text-zinc-500">
            Opens as a floating window. Tip: Option/Alt-click any menu item.
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
