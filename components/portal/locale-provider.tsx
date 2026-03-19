'use client'

import { LocaleContext } from '@/lib/portal/use-locale'
import type { Locale } from '@/lib/portal/i18n'

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return (
    <LocaleContext.Provider value={locale}>
      {children}
    </LocaleContext.Provider>
  )
}
