'use client'

// Client iPhone app, Overview redesign (dev job 056a70d0): the company card at the top of the Overview.
// It replaces the page heading and the old "Company Info" box: the company's name, type and state, then the numbers a client is asked for most
// often (EIN with a Copy button, formation date, filing ID). The round News button sits in its corner. Only the app draws it; the website's
// heading and Company Info box are unchanged.
import { useEffect, useRef, useState } from 'react'
import { Copy, MapPin } from 'lucide-react'
import { AppNewsButton } from '@/components/portal/app-overview/news-button'
import { useLocale } from '@/lib/portal/use-locale'
import { copyText } from '@/lib/portal-app/clipboard'
import type { NewsItem } from '@/lib/portal-app/news'

export interface AppCompanyHeroProps {
  name: string
  entityType: string | null
  state: string | null
  /** Already formatted; null when the company has no EIN yet. */
  ein: string | null
  /** Already formatted ("Mar 14, 2024" or a dash). */
  formed: string
  filingId: string | null
  news: NewsItem[]
}

export function AppCompanyHero({ name, entityType, state, ein, formed, filingId, news }: AppCompanyHeroProps) {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copyEin = async () => {
    if (!ein) return
    if (await copyText(ein)) {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <section
      data-testid="app-company-hero"
      className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-900 via-blue-700 to-blue-600 p-4 text-white shadow-sm"
    >
      <div className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-white/10 blur-xl" aria-hidden="true" />
      <div className="relative flex min-h-[44px] items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/70">{t('app.overview.company')}</p>
        <AppNewsButton items={news} />
      </div>
      <h1 className="relative mt-0.5 break-words text-[26px] font-bold leading-tight tracking-tight">{name}</h1>
      {(entityType || state) && (
        <div className="relative mt-2 flex flex-wrap gap-2">
          {entityType && <span className="rounded-full bg-white/15 px-3 py-1 text-[13px] font-medium">{entityType}</span>}
          {state && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-[13px] font-medium">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {state}
            </span>
          )}
        </div>
      )}
      <div className="relative mt-3.5 grid grid-cols-[1fr_1.3fr] gap-2">
        <div className="col-span-2 flex items-center justify-between gap-3 rounded-2xl bg-white/[0.12] px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-white/70">{t('dashboard.ein')}</p>
            <p data-testid="app-hero-ein" className="font-mono text-[15px] font-semibold tabular-nums">{ein ?? '—'}</p>
          </div>
          {ein && (
            <button
              type="button"
              onClick={copyEin}
              aria-label={`${t('app.overview.copy')} ${t('dashboard.ein')}`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/20 px-3 text-[13px] font-semibold text-white"
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              {copied ? t('app.overview.copied') : t('app.overview.copy')}
            </button>
          )}
        </div>
        <div className={`min-w-0 rounded-2xl bg-white/[0.12] px-3 py-2.5 ${filingId ? '' : 'col-span-2'}`}>
          <p className="text-xs font-medium text-white/70">{t('dashboard.formation')}</p>
          <p className="text-[15px] font-semibold tabular-nums">{formed}</p>
        </div>
        {filingId && (
          <div className="min-w-0 rounded-2xl bg-white/[0.12] px-3 py-2.5">
            <p className="text-xs font-medium text-white/70">{t('profile.filingId')}</p>
            <p className="break-words font-mono text-[15px] font-semibold tabular-nums">{filingId}</p>
          </div>
        )}
      </div>
    </section>
  )
}
