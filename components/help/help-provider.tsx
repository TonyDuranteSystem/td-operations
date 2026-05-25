'use client'

/**
 * HelpProvider — loads ALL help blurbs ONCE per session and exposes them, plus a
 * global "Show help" toggle, to every <HelpDot>. The dots stay hidden until the
 * toggle is on (Antonio's choice — keep the CRM clean by default). The toggle
 * state persists in localStorage so it sticks across pages.
 *
 * One fetch, not one-per-dot: <HelpDot> reads from this context's map by key.
 * Renders a small floating pill (bottom-left) to flip help on/off.
 * See sysdoc help-system-plan.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { HelpEntry } from '@/app/api/help-content/route'

interface HelpContextValue {
  helpOn: boolean
  toggle: () => void
  get: (key: string) => HelpEntry | null
}

const HelpContext = createContext<HelpContextValue>({ helpOn: false, toggle: () => {}, get: () => null })

export function useHelp() {
  return useContext(HelpContext)
}

const STORAGE_KEY = 'td-help-on'

export function HelpProvider({ children }: { children: React.ReactNode }) {
  const [helpOn, setHelpOn] = useState(false)

  // Restore the toggle from localStorage on mount.
  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') setHelpOn(true)
    } catch {
      // ignore (private mode etc.)
    }
  }, [])

  // Fetch the whole help map once; only when help is turned on at least once.
  const { data: map } = useQuery<Record<string, HelpEntry>>({
    queryKey: ['help-content'],
    queryFn: () =>
      fetch('/api/help-content').then((r) => r.json()).then((d: { entries?: Record<string, HelpEntry> }) => d.entries || {}),
    enabled: helpOn,
    staleTime: 5 * 60 * 1000,
  })

  const toggle = useCallback(() => {
    setHelpOn((v) => {
      const next = !v
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  const get = useCallback((key: string): HelpEntry | null => (map ? map[key] ?? null : null), [map])

  return (
    <HelpContext.Provider value={{ helpOn, toggle, get }}>
      {children}
    </HelpContext.Provider>
  )
}
