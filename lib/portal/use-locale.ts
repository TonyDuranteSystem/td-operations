'use client'

import { createContext, useContext } from 'react'
import { t as translate, type Locale } from './i18n'

// `translations` holds a language loaded from portal_translations
// (lib/portal/translations-store.ts, dev job 12cab351) — populated for any
// locale outside SUPPORTED_LOCALES, empty ({}) for 'en'/'it' since those are
// fully covered by the static dictionary already. Kept as a plain object on
// context (not re-fetched here) so every t() call stays synchronous — no
// Client Component call site needs to change, or handle a loading state.
export interface LocaleContextValue {
  locale: Locale
  translations: Record<string, string>
}

export const LocaleContext = createContext<LocaleContextValue>({ locale: 'en', translations: {} })

export function useLocale() {
  const { locale, translations } = useContext(LocaleContext)
  return {
    locale,
    // Loaded map first, then the static dictionary's own en/key fallback
    // chain — identical result to before for every locale whose
    // `translations` is {} (i.e. every locale today, until content is
    // migrated into portal_translations — a later milestone).
    t: (key: string) => translations[key] ?? translate(key, locale),
    // Raw loaded map, exposed for callers with their OWN bilingual
    // fallback logic already keyed on the same "English text as its own
    // key" convention — e.g. wizard field labels
    // (components/portal/wizard/wizard-field.tsx, wizard-client.tsx),
    // which must layer this UNDER their existing `locale === 'it' &&
    // f.labelIt ? f.labelIt : f.label` logic, never replace it — `t()`
    // alone can't do that layering since it doesn't know about a field's
    // hand-written labelIt.
    translations,
  }
}
