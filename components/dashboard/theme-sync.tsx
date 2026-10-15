'use client'

import { useCallback, useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import {
  THEME_CHANGE_EVENT,
  THEME_CLASS,
  THEME_PRE_PAINT_SCRIPT,
  THEME_STORAGE_KEY,
  nextThemePref,
  normalizeThemePref,
  resolveIsDark,
  type ThemePref,
} from '@/lib/theme/crm-theme'

function readPref(): ThemePref {
  try {
    return normalizeThemePref(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'auto'
  }
}

function applyTheme(pref: ThemePref) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle(THEME_CLASS, resolveIsDark(pref, systemDark))
}

/** Pre-paint script (no white flash on load / in floating-window frames). Rendered once in the dashboard layout. */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_PRE_PAINT_SCRIPT }} />
}

/**
 * Keeps <html> in step with the saved preference and the computer / phone setting, and removes the dark class
 * when the dashboard unmounts so a soft navigation to a client-facing page can never carry it along.
 */
export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => applyTheme(readPref())
    sync()
    media.addEventListener('change', sync)
    window.addEventListener(THEME_CHANGE_EVENT, sync)
    window.addEventListener('storage', sync) // another tab / window changed it
    return () => {
      media.removeEventListener('change', sync)
      window.removeEventListener(THEME_CHANGE_EVENT, sync)
      window.removeEventListener('storage', sync)
      document.documentElement.classList.remove(THEME_CLASS)
    }
  }, [])
  return null
}

const LABEL: Record<ThemePref, string> = {
  auto: 'Theme: Auto (follows your device)',
  light: 'Theme: Light',
  dark: 'Theme: Dark',
}

/** One-tap Auto -> Light -> Dark button for the sidebar footer. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('auto')

  useEffect(() => {
    const refresh = () => setPref(readPref())
    refresh()
    window.addEventListener(THEME_CHANGE_EVENT, refresh)
    window.addEventListener('storage', refresh) // keep the icon right when another tab changes it
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const cycle = useCallback(() => {
    const next = nextThemePref(readPref())
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* private mode: still applies for this page view */
    }
    setPref(next)
    applyTheme(next)
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT)) // floating-window frames listen for 'storage'; same-page listeners for this
  }, [])

  const Icon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor
  return (
    <FastTooltip label={LABEL[pref]}>
      <button onClick={cycle} className="p-1.5 rounded hover:bg-sidebar-accent" aria-label={LABEL[pref]}>
        <Icon className="h-4 w-4" />
      </button>
    </FastTooltip>
  )
}
