/**
 * TD Communication — shared presentational landing page.
 *
 * The fixed layout (hero → problem → packages → portfolio → CTA, or the
 * "Coming Soon" teaser when content.coming_soon). Pure + prop-driven, no data
 * fetching, so it renders identically in two places:
 *   - the portal page (server) from the PUBLISHED content
 *   - the editor Preview (client) from the DRAFT content
 * Bilingual: localized via landingText (IT falls back to EN at render).
 *
 * The per-client enrollment CTA (Phase 5/6 "Start your brand audit") is NOT
 * rendered here — it is dynamic per logged-in client and stays in the portal
 * page so this component remains pure and reusable in the preview.
 */

import { Palette, Sparkles, Globe, Gem, ArrowRight, Check } from 'lucide-react'
import { landingText, portfolioDescription } from '@/lib/td-communication/landing-content'
import type { LandingContent, TdCommPackage } from '@/lib/td-communication/types'

/** Static teaser cards (decorative, not editable content) — unchanged from the original teaser. */
const TEASER_FEATURES = [
  { icon: Palette, en: 'Professional Logo Design', it: 'Design Logo Professionale', dEn: 'A distinctive logo crafted by designers — the face of your brand.', dIt: 'Un logo distintivo creato da designer — il volto del tuo brand.' },
  { icon: Globe, en: 'Landing Page Creation', it: 'Creazione Landing Page', dEn: 'A polished web page that turns visitors into customers.', dIt: 'Una pagina web curata che trasforma i visitatori in clienti.' },
  { icon: Gem, en: 'Complete Brand Identity', it: 'Identità di Marca Completa', dEn: 'Colors, fonts and style guidelines — a consistent look everywhere.', dIt: 'Colori, font e linee guida — un aspetto coerente ovunque.' },
] as const

function packageName(p: TdCommPackage, isIt: boolean): string {
  return isIt && p.name_it ? p.name_it : p.name_en
}
function packageDesc(p: TdCommPackage, isIt: boolean): string {
  const it = p.description_it
  const en = p.description_en
  return (isIt && it ? it : en) ?? ''
}

export function TdCommLanding({
  content,
  packages,
  locale,
  ctaHref,
}: {
  content: LandingContent
  packages: TdCommPackage[]
  locale: string
  /** When set, the CTA button is a link (portal). Omitted in the editor preview. */
  ctaHref?: string
}) {
  const isIt = locale === 'it'
  const heroHeadline = landingText(content, locale, 'hero_headline')
  const heroSub = landingText(content, locale, 'hero_subheadline')
  const problem = landingText(content, locale, 'problem_body')
  const ctaText = landingText(content, locale, 'cta_text')
  const portfolio = content.portfolio_items
  const activePackages = packages

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8 max-w-5xl mx-auto">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 via-blue-600 to-indigo-700 px-6 py-12 sm:px-12 sm:py-16 text-center text-white shadow-xl">
        <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-white/10 blur-3xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-indigo-400/20 blur-3xl" aria-hidden="true" />
        <div className="relative">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/30 backdrop-blur">
            <Palette className="h-8 w-8" />
          </div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider ring-1 ring-white/25">
            <Sparkles className="h-3.5 w-3.5" />
            TD Communication
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{heroHeadline}</h1>
          <p className="mt-3 text-lg font-medium text-blue-50 sm:text-xl">{heroSub}</p>
          {content.coming_soon && (
            <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-blue-100/90 sm:text-base">{problem}</p>
          )}
        </div>
      </div>

      {content.coming_soon ? (
        /* ---- Coming Soon teaser ---- */
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {TEASER_FEATURES.map((f) => (
            <div key={f.en} className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm transition-shadow hover:shadow-md">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                <f.icon className="h-6 w-6" />
              </div>
              <h3 className="text-sm font-semibold text-zinc-900">{isIt ? f.it : f.en}</h3>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">{isIt ? f.dIt : f.dEn}</p>
            </div>
          ))}
        </div>
      ) : (
        /* ---- Full landing page ---- */
        <>
          {/* Problem statement */}
          {problem && (
            <section className="mt-10 max-w-3xl mx-auto text-center">
              <p className="text-base leading-relaxed text-zinc-700 sm:text-lg whitespace-pre-line">{problem}</p>
            </section>
          )}

          {/* Packages */}
          {activePackages.length > 0 && (
            <section className="mt-12">
              <h2 className="text-center text-2xl font-bold text-zinc-900">{isIt ? 'I nostri pacchetti' : 'Our packages'}</h2>
              <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {activePackages.map((p) => (
                  <div
                    key={p.slug}
                    className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm ${p.highlighted ? 'border-blue-500 ring-1 ring-blue-500' : 'border-zinc-200'}`}
                  >
                    {p.highlighted && (
                      <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                        {isIt ? 'Più popolare' : 'Most Popular'}
                      </span>
                    )}
                    <h3 className="text-lg font-semibold text-zinc-900">{packageName(p, isIt)}</h3>
                    {packageDesc(p, isIt) && <p className="mt-1.5 text-sm text-zinc-500">{packageDesc(p, isIt)}</p>}
                    {typeof p.price_usd === 'number' && (
                      <p className="mt-4 text-3xl font-bold text-zinc-900">
                        ${p.price_usd.toLocaleString('en-US')}
                      </p>
                    )}
                    {p.includes.length > 0 && (
                      <ul className="mt-4 space-y-2 text-sm text-zinc-600">
                        {p.includes.map((inc, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                            <span>{inc}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {typeof p.delivery_days === 'number' && (
                      <p className="mt-4 text-xs text-zinc-400">
                        {isIt ? `Consegna in ~${p.delivery_days} giorni` : `Delivered in ~${p.delivery_days} days`}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Portfolio */}
          {portfolio.length > 0 && (
            <section className="mt-14">
              <h2 className="text-center text-2xl font-bold text-zinc-900">{isIt ? 'Il nostro lavoro' : 'Our work'}</h2>
              <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {portfolio.map((item, i) => (
                  <figure key={i} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.image_url} alt={item.client_name || 'Portfolio'} className="aspect-[4/3] w-full object-cover" />
                    <figcaption className="p-4">
                      {item.client_name && <p className="text-sm font-semibold text-zinc-900">{item.client_name}</p>}
                      {portfolioDescription(item, locale) && (
                        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{portfolioDescription(item, locale)}</p>
                      )}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}

          {/* CTA */}
          {ctaText && (
            <section className="mt-14 mb-2 flex justify-center">
              {ctaHref ? (
                <a
                  href={ctaHref}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
                >
                  {ctaText}
                  <ArrowRight className="h-4 w-4" />
                </a>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-sm">
                  {ctaText}
                  <ArrowRight className="h-4 w-4" />
                </span>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
