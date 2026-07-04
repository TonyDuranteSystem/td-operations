'use client'

/**
 * TD Communication Phase 14 — public portfolio gallery (client component).
 *
 * Renders on the unauthenticated /portfolio page. Bilingual EN/IT via a simple
 * toggle (there's no logged-in user to read a locale from). Before/after is shown
 * side-by-side (v1 — an interactive slider is a safe v2 add); an entry with no
 * "before" shows just the result. Category + tag filters are derived from the data.
 */

import { useMemo, useState } from 'react'
import { portfolioText, filterPublicEntries } from '@/lib/td-communication/portfolio'
import type { PublicPortfolioEntry } from '@/lib/td-communication/types'

export function PublicPortfolio({
  entries,
  categories,
}: {
  entries: PublicPortfolioEntry[]
  categories: string[]
}) {
  const [locale, setLocale] = useState<'en' | 'it'>('en')
  const [category, setCategory] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)

  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const e of entries) for (const t of e.tags) s.add(t)
    return Array.from(s).sort()
  }, [entries])

  const shown = useMemo(() => filterPublicEntries(entries, { category, tag }), [entries, category, tag])

  const t = (en: string, it: string) => (locale === 'it' ? it : en)

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-10 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-blue-600 mb-2">TD Communication</p>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{t('Our Work', 'I Nostri Lavori')}</h1>
            <p className="mt-2 text-zinc-500 max-w-xl">
              {t(
                'A selection of branding and identity projects we have designed for our clients.',
                'Una selezione di progetti di branding e identità che abbiamo realizzato per i nostri clienti.',
              )}
            </p>
          </div>
          <div className="shrink-0 flex rounded-lg border border-zinc-200 overflow-hidden text-sm">
            {(['en', 'it'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={locale === l ? 'px-3 py-1.5 bg-blue-600 text-white' : 'px-3 py-1.5 text-zinc-600 hover:bg-zinc-50'}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Filters */}
      {(categories.length > 0 || allTags.length > 0) && (
        <div className="mx-auto max-w-6xl px-6 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip active={!category && !tag} onClick={() => { setCategory(null); setTag(null) }}>{t('All', 'Tutti')}</FilterChip>
            {categories.map((c) => (
              <FilterChip key={c} active={category === c} onClick={() => { setCategory(category === c ? null : c); setTag(null) }}>{c}</FilterChip>
            ))}
            {allTags.map((tg) => (
              <FilterChip key={tg} subtle active={tag === tg} onClick={() => { setTag(tag === tg ? null : tg); setCategory(null) }}>#{tg}</FilterChip>
            ))}
          </div>
        </div>
      )}

      {/* Grid */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        {shown.length === 0 ? (
          <p className="py-20 text-center text-zinc-400">{t('Nothing here yet — check back soon.', 'Ancora niente — torna presto.')}</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((e) => (
              <article key={e.id} className="rounded-2xl border border-zinc-200 bg-white overflow-hidden shadow-sm">
                <div className="grid grid-cols-2 aspect-[16/10] bg-zinc-100">
                  {e.before_image_url ? (
                    <figure className="relative border-r border-zinc-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={e.before_image_url} alt="before" className="h-full w-full object-contain p-3" />
                      <figcaption className="absolute bottom-1 left-1 text-[10px] font-medium bg-white/80 px-1.5 py-0.5 rounded text-zinc-500">{t('Before', 'Prima')}</figcaption>
                    </figure>
                  ) : <div />}
                  <figure className={e.before_image_url ? 'relative' : 'relative col-span-2'}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={e.after_image_url} alt={e.title_en || e.client_name} className="h-full w-full object-contain p-3" />
                    {e.before_image_url && <figcaption className="absolute bottom-1 left-1 text-[10px] font-medium bg-blue-600/90 px-1.5 py-0.5 rounded text-white">{t('After', 'Dopo')}</figcaption>}
                  </figure>
                </div>
                <div className="p-5">
                  {e.category && <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-600 mb-1">{e.category}</p>}
                  <h2 className="font-semibold text-lg leading-tight">{portfolioText(e, locale, 'title') || e.client_name}</h2>
                  {e.client_name && portfolioText(e, locale, 'title') && <p className="text-sm text-zinc-500">{e.client_name}</p>}
                  {portfolioText(e, locale, 'description') && (
                    <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{portfolioText(e, locale, 'description')}</p>
                  )}
                  {e.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {e.tags.map((tg) => <span key={tg} className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">#{tg}</span>)}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function FilterChip({ children, active, subtle, onClick }: { children: React.ReactNode; active: boolean; subtle?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'text-sm px-3 py-1.5 rounded-full bg-blue-600 text-white'
          : subtle
            ? 'text-sm px-3 py-1.5 rounded-full bg-white border border-zinc-200 text-zinc-500 hover:border-zinc-300'
            : 'text-sm px-3 py-1.5 rounded-full bg-white border border-zinc-200 text-zinc-700 hover:border-zinc-300'
      }
    >
      {children}
    </button>
  )
}
