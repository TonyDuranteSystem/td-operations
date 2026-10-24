'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { THEMES, THEME_COOKIE, THEME_MESSAGE, parseTheme, type Theme } from '@/lib/marketing/theme'

const LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/** Light | Dark | System (follow the computer) at the bottom of the sidebar. The choice is a cookie in this browser; the page and any open lead windows change at once. */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const t = useT()
  const [theme, setTheme] = useState<Theme>(initial)
  useEffect(() => { setTheme(parseTheme(document.getElementById('tdm-root')?.getAttribute('data-tdm-theme'))) }, [])
  const pick = (next: Theme) => {
    setTheme(next)
    try { document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax` } catch { /* the choice still applies to this page */ }
    document.getElementById('tdm-root')?.setAttribute('data-tdm-theme', next)
    document.querySelectorAll('iframe').forEach(f => f.contentWindow?.postMessage({ type: THEME_MESSAGE, theme: next }, window.location.origin))
  }
  return (
    <div role="group" aria-label={t('Look')} data-testid="theme-switch">
      <p className="mb-1 text-[11px] text-slate-400">{t('Look')}</p>
      <div className="flex overflow-hidden rounded-lg border text-xs">
        {THEMES.map(th => (
          <button key={th} type="button" aria-pressed={theme === th} data-testid={`theme-${th}`} onClick={() => pick(th)}
            className={`flex-1 px-2 py-1 ${theme === th ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{t(LABEL[th])}</button>
        ))}
      </div>
    </div>
  )
}
