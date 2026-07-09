/**
 * Bank Applications — self-service guidance for a formed client opening a
 * business bank account. Replaces the old Banking Fintech SD/wizard flow
 * (removed 2026-06-20): formation finishes at the EIN, and the client opens an
 * account themselves at a fintech of their choice with their EIN + Articles of
 * Organization. This page lists the recommended providers + the key rules
 * (what you need, never share the SS-4, describe your business clearly).
 *
 * Static curated list — edit RECOMMENDED_BANKS to change providers/links.
 */

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getLocale } from '@/lib/portal/i18n'
import { Landmark, FileText, ShieldAlert, PencilLine, ExternalLink, ArrowRight } from 'lucide-react'

export const dynamic = 'force-dynamic'

interface BankOption {
  name: string
  /**
   * Where the tile links. For self-service banks this is the provider's
   * official site (opens in a new tab). For MANAGED banks (Relay, Payset)
   * this is the internal wizard form URL — same-tab navigation, no new tab.
   */
  url: string
  /** Currency / positioning tag. */
  tag: string
  descEn: string
  descIt: string
  /**
   * Managed = TD prepares and submits the application on the client's behalf.
   * The tile opens the internal intake form (`/portal/wizard?type=...`)
   * instead of the bank's own site. Relay + Payset only — this is the flow
   * the team still runs (Antonio confirmed 2026-07-08). Self-service banks
   * omit this flag and link out to the provider.
   */
  managed?: boolean
}

// Recommended fintech providers. Managed banks (Relay, Payset) open the
// internal "we submit for you" intake form; the rest link to each provider's
// official site — verify external URLs before changing. Antonio can edit this
// list freely.
const RECOMMENDED_BANKS: BankOption[] = [
  {
    name: 'Relay',
    url: '/portal/wizard?type=banking_relay',
    tag: 'USD',
    managed: true,
    descEn: 'US business account (USD) — fill in your details and we prepare and submit the application for you.',
    descIt: 'Conto business USA (USD) — inserisci i tuoi dati e prepariamo e inviamo la richiesta per te.',
  },
  {
    name: 'Payset',
    url: '/portal/wizard?type=banking_payset',
    tag: 'EUR / Multi-currency',
    managed: true,
    descEn: 'EUR/IBAN multi-currency account — fill in your details and we submit the application for you.',
    descIt: 'Conto multivaluta EUR/IBAN — inserisci i tuoi dati e inviamo la richiesta per te.',
  },
  {
    name: 'Mercury',
    url: 'https://mercury.com/',
    tag: 'USD',
    descEn: 'US banking popular with startups and e-commerce — fast online application.',
    descIt: 'Banca USA molto usata da startup ed e-commerce — domanda online veloce.',
  },
  {
    name: 'Sokin',
    url: 'https://www.sokin.com/',
    tag: 'Multi-currency',
    descEn: 'Multi-currency account for international payments and transfers.',
    descIt: 'Conto multivaluta per pagamenti e bonifici internazionali.',
  },
  {
    name: 'Wise',
    url: 'https://wise.com/business/',
    tag: 'Multi-currency',
    descEn: 'Multi-currency business account with low-cost international transfers.',
    descIt: 'Conto business multivaluta con bonifici internazionali a basso costo.',
  },
]

const COPY = {
  en: {
    title: 'Bank Applications',
    subtitle: 'Open your business bank account online with your EIN and Articles of Organization.',
    needTitle: 'What you need',
    needBody:
      'To open a business bank account you only need two documents — both are in your portal under Documents:',
    needItems: ['Your EIN (the IRS confirmation letter, CP 575)', 'Your Articles of Organization'],
    ss4Title: 'Never share your signed SS-4',
    ss4Body:
      'The signed SS-4 is an internal tax document and is NOT needed to open a bank account or run your business. Do not send it to a bank or anyone else.',
    describeTitle: 'Describe your business clearly',
    describeBody:
      'Banks ask what your company does. Give a specific, accurate description — what you sell, to whom, and how you get paid. Vague answers like "consulting" or "online business" slow approval or cause rejections.',
    recommendedTitle: 'Recommended providers',
    apply: 'Apply',
    applyManaged: 'Start application',
    managedBadge: 'We submit for you',
    help: 'Not sure which one fits you best? Message us anytime in the portal chat.',
  },
  it: {
    title: 'Apertura Conto Bancario',
    subtitle: 'Apri il tuo conto bancario aziendale online con il tuo EIN e l’Atto Costitutivo.',
    needTitle: 'Cosa ti serve',
    needBody:
      'Per aprire un conto bancario aziendale ti bastano due documenti — entrambi sono nel portale, nella sezione Documenti:',
    needItems: ['Il tuo EIN (la lettera di conferma dell’IRS, CP 575)', 'Il tuo Atto Costitutivo (Articles of Organization)'],
    ss4Title: 'Non condividere mai il tuo SS-4 firmato',
    ss4Body:
      'Il modulo SS-4 firmato è un documento fiscale interno e NON serve per aprire il conto bancario né per gestire la tua attività. Non inviarlo a una banca né a nessun altro.',
    describeTitle: 'Descrivi chiaramente la tua attività',
    describeBody:
      'Le banche chiedono cosa fa la tua azienda. Fornisci una descrizione precisa e accurata: cosa vendi, a chi e come vieni pagato. Risposte vaghe come "consulenza" o "business online" rallentano l’approvazione o causano rifiuti.',
    recommendedTitle: 'Provider consigliati',
    apply: 'Candidati',
    applyManaged: 'Compila richiesta',
    managedBadge: 'Ce ne occupiamo noi',
    help: 'Non sai quale fa per te? Scrivici quando vuoi nella chat del portale.',
  },
}

export default async function PortalBanksPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const locale = getLocale(user)
  const c = COPY[locale] ?? COPY.en

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
          <Landmark className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{c.title}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">{c.subtitle}</p>
        </div>
      </div>

      {/* What you need */}
      <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-zinc-500" />
          <h2 className="text-sm font-semibold text-zinc-800">{c.needTitle}</h2>
        </div>
        <p className="text-sm text-zinc-600">{c.needBody}</p>
        <ul className="space-y-1.5">
          {c.needItems.map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm text-zinc-700">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* Never share SS-4 — emphasized warning */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-semibold text-amber-900">{c.ss4Title}</h2>
          <p className="text-sm text-amber-800 mt-1">{c.ss4Body}</p>
        </div>
      </div>

      {/* Describe your business */}
      <div className="bg-white rounded-xl border shadow-sm p-5 flex items-start gap-3">
        <PencilLine className="h-4 w-4 text-zinc-500 shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-semibold text-zinc-800">{c.describeTitle}</h2>
          <p className="text-sm text-zinc-600 mt-1">{c.describeBody}</p>
        </div>
      </div>

      {/* Recommended providers */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{c.recommendedTitle}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {RECOMMENDED_BANKS.map((bank) => (
            <a
              key={bank.name}
              href={bank.url}
              // Managed tiles (Relay, Payset) navigate to the internal intake
              // form in the same tab. Self-service tiles open the provider's
              // site in a new tab.
              {...(bank.managed ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
              className={`group flex flex-col gap-1.5 rounded-xl border p-4 transition-colors ${
                bank.managed
                  ? 'border-blue-200 bg-blue-50/40 hover:border-blue-400 hover:bg-blue-50'
                  : 'border-zinc-200 bg-white hover:border-blue-300 hover:bg-blue-50/30'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-zinc-900">{bank.name}</span>
                <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                  {bank.tag}
                </span>
              </div>
              {bank.managed && (
                <span className="inline-flex w-fit items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                  {c.managedBadge}
                </span>
              )}
              <p className="text-xs text-zinc-500">{locale === 'it' ? bank.descIt : bank.descEn}</p>
              <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600 group-hover:text-blue-700">
                {bank.managed ? c.applyManaged : c.apply}
                {bank.managed ? <ArrowRight className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />}
              </span>
            </a>
          ))}
        </div>
      </div>

      <p className="text-xs text-zinc-500">{c.help}</p>
    </div>
  )
}
