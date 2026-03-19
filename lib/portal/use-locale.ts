'use client'

import { createContext, useContext } from 'react'
import { t as translate, type Locale } from './i18n'

export const LocaleContext = createContext<Locale>('en')

export function useLocale() {
  const locale = useContext(LocaleContext)
  return {
    locale,
    t: (key: string) => translate(key, locale),
  }
}
