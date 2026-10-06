/**
 * Plain (non-React-component) pieces shared by the window manager and whatever opens a window.
 * Kept in a .ts file so unit tests that import the pieces never have to load a .tsx component.
 */

import { createContext, useContext, useEffect, useState } from 'react'
import { WINDOWS_MIN_VIEWPORT_WIDTH } from '@/lib/windows/window-model'

/** True when the CRM is allowed to open floating windows right now (admin switch on, desktop shell). */
export const WindowsAvailableContext = createContext(false)

/** The name every pop-out browser window gets (see the manager's "separate browser window" button). */
export const POPOUT_NAME = 'td-popout'

/**
 * True inside a floating window's page (a frame) or inside a pop-out browser window. Neither has a window
 * manager, so neither may offer to open a window — a click that was swallowed for "open as a window" with
 * nobody listening would leave the person nowhere.
 */
export function isFramedOrPopout(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.self !== window.top) return true
  } catch {
    return true
  }
  return window.name.startsWith(POPOUT_NAME)
}

export function useWindowsAvailable(): boolean {
  const available = useContext(WindowsAvailableContext)
  // Decided after mount (the name / frame are not known on the server); until then it follows the server's answer.
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    setBlocked(isFramedOrPopout())
  }, [])
  return available && !blocked
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
  if (isFramedOrPopout()) return false // never from inside a frame or a pop-out browser window
  return window.innerWidth >= WINDOWS_MIN_VIEWPORT_WIDTH
}

/** The DOM events that start the guided tour / open the feedback box (so any button anywhere can do it). */
export const START_TOUR_EVENT = 'td-start-windows-tour'
export const OPEN_FEEDBACK_EVENT = 'td-open-windows-feedback'

export function startWindowsTour(): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent(START_TOUR_EVENT))
}

export function openWindowsFeedback(): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent(OPEN_FEEDBACK_EVENT))
}
