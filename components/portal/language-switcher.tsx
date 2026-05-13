'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'
import { useRouter } from 'next/navigation'
import { SUPPORTED_LOCALES, LOCALE_LABELS, type Locale } from '@/lib/portal/i18n'

export function LanguageSwitcher() {
  const { locale } = useLocale()
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const handleChange = async (lang: Locale) => {
    if (lang === locale) return
    setLoading(true)
    try {
      const res = await fetch('/api/portal/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to update language')
      }
      toast.success(lang === 'it' ? 'Lingua aggiornata' : 'Language updated')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to update language')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {SUPPORTED_LOCALES.map((lang) => (
        <button
          key={lang}
          onClick={() => handleChange(lang)}
          disabled={loading}
          className={`px-4 py-2.5 text-sm rounded-lg font-medium transition-colors ${
            locale === lang ? 'bg-blue-600 text-white' : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
          }`}
        >
          {LOCALE_LABELS[lang]}
        </button>
      ))}
      {loading && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
    </div>
  )
}
