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
 * Deliberately minimal: this context only knows whether the tool is open.
 * Everything about WHERE the flow currently is (choosing a mode, selecting an
 * area, previewing the result) lives as CaptureLayer's own local state — the
 * same separation HelpProvider/HelpDot use.
 */
import { createContext, useCallback, useContext, useState } from 'react'

interface CaptureContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
}

const CaptureContext = createContext<CaptureContextValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
})

export function useCapture() {
  return useContext(CaptureContext)
}

export function CaptureProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])

  return (
    <CaptureContext.Provider value={{ isOpen, open, close }}>
      {children}
    </CaptureContext.Provider>
  )
}
