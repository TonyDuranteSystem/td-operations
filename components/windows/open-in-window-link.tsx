'use client'

import type { AnchorHTMLAttributes } from 'react'
import { isWindowLinkClick } from '@/lib/windows/open-intent'
import { isWindowableUrl } from '@/lib/windows/window-model'
import { canOpenWindowNow, requestOpenWindow, useWindowsAvailable } from '@/lib/windows/windows-context'

/**
 * A real link that opens its page as a FLOATING WINDOW when windows are available (Antonio 2026-10-16: "when I click Open workspace it
 * opens the workspace in a floating window instead of another page").
 *
 *  - It is an ordinary <a href>: with windows off, on a screen narrower than 1024px, inside a window / pop-out, or with Cmd/Ctrl/Shift held
 *    it behaves exactly like a link (same tab; Cmd/Ctrl = new tab), so nobody is ever left with a click that did nothing;
 *  - a plain left click or Option/Alt + click, when `canOpenWindowNow`, opens the window instead and the page behind stays put.
 */
export function OpenInWindowLink({
  href,
  title,
  onClick,
  children,
  ...rest
}: { href: string; title: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'title'>) {
  const windowsAvailable = useWindowsAvailable()
  return (
    <a
      {...rest}
      href={href}
      onClick={e => {
        onClick?.(e)
        if (e.defaultPrevented) return
        if (!isWindowLinkClick(e)) return
        if (!canOpenWindowNow(windowsAvailable)) return
        if (!isWindowableUrl(href)) return // a page that cannot be a window stays an ordinary link: never a click that does nothing
        e.preventDefault()
        requestOpenWindow(href, title)
      }}
    >
      {children}
    </a>
  )
}
