'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, ChevronDown, Search, Check, Globe } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'
import { useRouter } from 'next/navigation'
import { t as translate, type Locale } from '@/lib/portal/i18n'
import { LANGUAGE_NAMES } from '@/lib/portal/language-codes'
import { flagEmojiForLanguage } from '@/lib/portal/language-flags'

/**
 * Any-language picker (dev job 12cab351) — replaces the old English/Italian
 * two-button toggle. Offers the full real ISO-639-1 list (~180 languages,
 * lib/portal/language-codes.ts); picking one already-translated shows it
 * immediately, picking a brand-new one saves instantly and starts translating
 * in the background (app/api/portal/language/route.ts), falling back to
 * English for anything not yet done until that finishes.
 */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, t } = useLocale()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const currentCode = (locale as string).toLowerCase()
  const currentFlag = flagEmojiForLanguage(currentCode)

  const entries = Object.entries(LANGUAGE_NAMES) as Array<[string, string]>
  const q = query.trim().toLowerCase()
  const filtered = q
    ? entries.filter(([code, name]) => name.toLowerCase().includes(q) || code.toLowerCase() === q)
    : entries
  filtered.sort((a, b) => a[1].localeCompare(b[1]))

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [open])

  const handleChange = async (lang: string) => {
    setOpen(false)
    setQuery('')
    if (lang === currentCode) return
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
      toast.success(translate('languageSwitcher.updated', lang as Locale))
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to update language')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={loading}
        className={
          compact
            ? 'flex items-center gap-1 px-2 py-1 text-xs rounded-md font-medium text-zinc-600 hover:bg-zinc-100 transition-colors disabled:opacity-60'
            : 'flex items-center gap-1.5 px-4 py-2.5 text-sm rounded-lg font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50 transition-colors disabled:opacity-60'
        }
      >
        {loading ? (
          <Loader2 className={compact ? 'h-3.5 w-3.5 animate-spin' : 'h-4 w-4 animate-spin'} />
        ) : (
          <>
            {currentFlag ? (
              <span className={compact ? 'text-sm leading-none shrink-0' : 'text-base leading-none shrink-0'} aria-hidden="true">
                {currentFlag}
              </span>
            ) : (
              <Globe className={compact ? 'h-3.5 w-3.5 shrink-0' : 'h-4 w-4 shrink-0'} />
            )}
            <span className="truncate max-w-[8rem]">{t('languageSwitcher.changeLanguage')}</span>
            <ChevronDown className={compact ? 'h-3 w-3 shrink-0' : 'h-3.5 w-3.5 shrink-0'} />
          </>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 bg-white rounded-xl border shadow-lg overflow-hidden">
          <div className="p-2 border-b border-zinc-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('languageSwitcher.searchPlaceholder')}
                className="w-full pl-8 pr-2 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-zinc-400 text-center">
                {t('languageSwitcher.noResults')}
              </p>
            ) : (
              filtered.map(([code, name]) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => handleChange(code)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left hover:bg-zinc-50 transition-colors ${
                    code === currentCode ? 'text-blue-700 font-medium' : 'text-zinc-700'
                  }`}
                >
                  <span className="truncate">{name}</span>
                  {code === currentCode && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
