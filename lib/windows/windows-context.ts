/**
 * Plain (non-React-component) pieces shared by the window manager and whatever opens a window.
 * Kept in a .ts file so unit tests that import the pieces never have to load a .tsx component.
 */

import { createContext, useContext } from 'react'
import { WINDOWS_MIN_VIEWPORT_WIDTH } from '@/lib/windows/window-model'

/** True when the CRM is allowed to open floating windows right now (admin switch on, desktop shell). */
export const WindowsAvailableContext = createContext(false)

export function useWindowsAvailable(): boolean {
  return useContext(WindowsAvailableContext)
}

/** The DOM event the window manager listens for. */
export const OPEN_WINDOW_EVENT = 'td-open-window'

export interface OpenWindowDetail {
  href: string
  title?: string
}

/** Ask the window manager to open a CRM page in a floating window. Safe to call from anywhere. */
export function requestOpenWindow(href: string, title?: string): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent<OpenWindowDetail>(OPEN_WINDOW_EVENT, { detail: { href, title } }))
}

/**
 * True when a click/keystroke that means "open as a window" should be intercepted RIGHT NOW: windows
 * are on AND the screen is wide enough to show them. Callers intercept only when this is true, so on
 * a narrow screen the normal navigation still happens (an intercepted click that opens nothing would
 * leave the person nowhere).
 */
export function canOpenWindowNow(available: boolean): boolean {
  if (!available || typeof window === 'undefined') return false
  try {
    if (window.self !== window.top) return false // never from inside a frame
  } catch {
    return false
  }
  return window.innerWidth >= WINDOWS_MIN_VIEWPORT_WIDTH
}
