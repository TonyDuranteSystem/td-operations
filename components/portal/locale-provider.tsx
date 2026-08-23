'use client'

import { LocaleContext } from '@/lib/portal/use-locale'
import type { Locale } from '@/lib/portal/i18n'

export function LocaleProvider({
  locale,
  translations = {},
  children,
}: {
  locale: Locale
  /** From loadTranslationsForLocale() — omitted defaults to {} (dev job 12cab351). */
  translations?: Record<string, string>
  children: React.ReactNode
}) {
  return (
    <LocaleContext.Provider value={{ locale, translations }}>
      {children}
    </LocaleContext.Provider>
  )
}
