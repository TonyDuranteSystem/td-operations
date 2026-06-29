/**
 * TD Communication — client-facing "Coming Soon" page (Phase 4).
 *
 * A static teaser for the upcoming TD Communication branding service
 * (professional logos, landing pages, full brand identity — produced through
 * the staff↔partner studio that already exists at /dashboard/td-communication
 * + /collab). This page has NO database queries and NO enrollment logic — it
 * only makes active-tier clients curious about what's coming. The sidebar entry
 * (active-tier only) lives in components/portal/portal-sidebar.tsx.
 *
 * Bilingual via getLocale (user metadata). Server component, mirrors the
 * /portal/banks pattern: auth guard → locale → render.
 */

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getLocale } from '@/lib/portal/i18n'
import { Palette, Sparkles, Globe, Gem, BellRing } from 'lucide-react'

export const dynamic = 'force-dynamic'

interface Feature {
  icon: typeof Palette
  titleEn: string
  titleIt: string
  descEn: string
  descIt: string
}

const FEATURES: Feature[] = [
  {
    icon: Palette,
    titleEn: 'Professional Logo Design',
    titleIt: 'Design Logo Professionale',
    descEn: 'A distinctive logo crafted by designers — the face of your brand.',
    descIt: 'Un logo distintivo creato da designer — il volto del tuo brand.',
  },
  {
    icon: Globe,
    titleEn: 'Landing Page Creation',
    titleIt: 'Creazione Landing Page',
    descEn: 'A polished web page that turns visitors into customers.',
    descIt: 'Una pagina web curata che trasforma i visitatori in clienti.',
  },
  {
    icon: Gem,
    titleEn: 'Complete Brand Identity',
    titleIt: 'Identità di Marca Completa',
    descEn: 'Colors, fonts and style guidelines — a consistent look everywhere.',
    descIt: 'Colori, font e linee guida — un aspetto coerente ovunque.',
  },
]

export default async function TdCommunicationPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const locale = getLocale(user)
  const isIt = locale === 'it'

  const headline = isIt ? 'Presto Disponibile' : 'Coming Soon'
  const subhead = isIt
    ? 'Branding professionale per la tua azienda'
    : 'Professional branding for your business'
  const description = isIt
    ? "Stiamo costruendo qualcosa di speciale per far risaltare la tua azienda. Logo professionali, landing page e identità di marca — progettati da esperti e consegnati direttamente nel tuo portale."
    : "We're building something special to help your business stand out. Professional logos, landing pages, and brand identity — designed by experts, delivered through your portal."
  const notify = isIt
    ? 'Ti avviseremo non appena sarà pronto.'
    : "We'll notify you when it's ready."
  const badge = isIt ? 'TD Communication' : 'TD Communication'

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8 max-w-5xl mx-auto">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 via-blue-600 to-indigo-700 px-6 py-12 sm:px-12 sm:py-16 text-center text-white shadow-xl">
        {/* Decorative glow */}
        <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-white/10 blur-3xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full bg-indigo-400/20 blur-3xl" aria-hidden="true" />

        <div className="relative">
          {/* Logo / icon */}
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/30 backdrop-blur">
            <Palette className="h-8 w-8" />
          </div>

          {/* Brand label */}
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider ring-1 ring-white/25">
            <Sparkles className="h-3.5 w-3.5" />
            {badge}
          </div>

          {/* Headline */}
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{headline}</h1>

          {/* Subheadline */}
          <p className="mt-3 text-lg font-medium text-blue-50 sm:text-xl">{subhead}</p>

          {/* Description */}
          <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-blue-100/90 sm:text-base">
            {description}
          </p>
        </div>
      </div>

      {/* Teaser feature cards */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <div
            key={f.titleEn}
            className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <f.icon className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900">
              {isIt ? f.titleIt : f.titleEn}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              {isIt ? f.descIt : f.descEn}
            </p>
          </div>
        ))}
      </div>

      {/* Notify banner */}
      <div className="mt-8 flex items-center justify-center gap-3 rounded-2xl border border-blue-100 bg-blue-50/60 px-6 py-4 text-center">
        <BellRing className="h-5 w-5 shrink-0 text-blue-600" />
        <p className="text-sm font-medium text-blue-900">{notify}</p>
      </div>
    </div>
  )
}
