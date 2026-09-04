'use client'

/**
 * CaptureProvider — the shared open/closed switch between the top-bar button
 * (rendered inside DashboardHeader / Sidebar) and CaptureLayer (mounted once
 * at the dashboard layout level, outside <main>, so it survives page
 * navigation — Antonio, 2026-09-04: "the screenshot page must stay open if I
 * move in different page to send it"). Mirrors components/help/help-provider.tsx's
 * shape on purpose — same codebase, same job (a header toggle + a
 * layout-level consumer), no reason to invent a different pattern.
 *
 * `isBrowseOpen` is the SAME shape for "My captures" (Antonio, 2026-09-04:
 * "when I click on my pictures I don't want to leave the page where I am but
 * a new page should popup") — a second, independent on/off switch, not a
 * shared "mode" with the capture flow, since a browse-open state does not
 * need any of the capture flow's stage machine.
 *
 * Deliberately minimal: this context only knows whether each tool is open.
 * Everything about WHERE the capture flow currently is (choosing a mode,
 * selecting an area, previewing the result) lives as CaptureLayer's own
 * local state — the same separation HelpProvider/HelpDot use.
 */
import { createContext, useCallback, useContext, useState } from 'react'

interface CaptureContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
  isBrowseOpen: boolean
  openBrowse: () => void
  closeBrowse: () => void
}

const CaptureContext = createContext<CaptureContextValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
  isBrowseOpen: false,
  openBrowse: () => {},
  closeBrowse: () => {},
})

export function useCapture() {
  return useContext(CaptureContext)
}

export function CaptureProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])

  const [isBrowseOpen, setIsBrowseOpen] = useState(false)
  const openBrowse = useCallback(() => setIsBrowseOpen(true), [])
  const closeBrowse = useCallback(() => setIsBrowseOpen(false), [])

  return (
    <CaptureContext.Provider value={{ isOpen, open, close, isBrowseOpen, openBrowse, closeBrowse }}>
      {children}
    </CaptureContext.Provider>
  )
}
