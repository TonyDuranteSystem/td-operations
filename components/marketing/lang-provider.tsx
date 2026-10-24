'use client'

import { createContext, useContext, useMemo } from 'react'
import { makeT, type TFn } from '@/lib/marketing/i18n'
import type { Lang } from '@/lib/marketing/templates'

const Ctx = createContext<{ lang: Lang; t: TFn }>({ lang: 'it', t: makeT('it') })

/** Gives the screens' client components the person's language. The frame (a server component) reads the cookie and passes it down. */
export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const value = useMemo(() => ({ lang, t: makeT(lang) }), [lang])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useT = (): TFn => useContext(Ctx).t
export const useLang = (): Lang => useContext(Ctx).lang
