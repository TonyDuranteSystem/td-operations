// The Invoices screens of the CLIENT iPhone app (dev job 056a70d0; docs/systems/client-app.md): the home, and the small header that takes you
// back to it from an area. Drawn only inside the app (the page decides), in graphite gray like the Overview's company card.
// The home has three looks (lib/portal-app/invoices.ts `invoicesHomeMode`): the "before your first invoice" card for a company that is not
// set up yet, the "owed to you" card with the latest invoices once it is, and a plain list of areas for a person with no Sales area.
// Plain server components: links only, no script. Words are passed in already translated.
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Check, ChevronLeft, ChevronRight, Plus, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppStatusPill } from '@/components/portal/app-status-pill'
import type { AppArea, InvoicesHomeMode, StatusTone } from '@/lib/portal-app/invoices'

export interface AppStep {
  id: string
  label: string
  required: boolean
  done: boolean
  /** Where tapping the step leads; null = not a link (this person cannot open that area). */
  href: string | null
}

export interface AppLatestInvoice {
  id: string
  customer: string
  number: string
  dateLabel: string
  amountLabel: string
  status: string
  tone: StatusTone
  href: string
}

export interface AppInvoicesSummary {
  /** One line per currency ("$150.00", "€1,256.00"). */
  owed: string[]
  paid: string
  overdue: string
}

/** The graphite card: the same family as the Overview's company card, in gray. */
const HERO = 'relative overflow-hidden rounded-[22px] bg-gradient-to-br from-[#23272e] to-[#4a515e] p-4 text-white'

function Gear({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      data-testid="app-invoices-gear"
      aria-label={label}
      className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/35 bg-white/20 text-white"
    >
      <Settings className="h-5 w-5" aria-hidden="true" />
    </Link>
  )
}

function Chevron() {
  return <ChevronRight className="h-[18px] w-[18px] shrink-0 text-zinc-400" aria-hidden="true" />
}

export function AppInvoiceAreas({
  subtitle,
  mode,
  steps,
  stepsLeft,
  areas,
  summary,
  latest,
  salesCount,
  newInvoiceHref,
  setupHref,
  seeAllHref,
  tr,
}: {
  /** Which company this is ("Customers and invoices · Acme LLC"): small gray text above the cards. */
  subtitle: string
  mode: InvoicesHomeMode
  steps: AppStep[] | null
  stepsLeft: number
  areas: AppArea[]
  summary: AppInvoicesSummary | null
  latest: AppLatestInvoice[]
  salesCount: number
  /** Null = this person cannot create invoices (no company). */
  newInvoiceHref: string | null
  /** Null = this person cannot open Setup (no gear). */
  setupHref: string | null
  seeAllHref: string
  tr: (key: string) => string
}) {
  const doneCount = steps ? steps.filter(s => s.done).length : 0
  const totalSteps = steps ? steps.length : 0
  // The Setup row is gone from the list (the gear opens it). Sales is covered by the card and "See all" once the company is set up.
  const linkAreas = areas.filter(a => a.id !== 'setup' && (mode === 'steps' || mode === 'links' ? true : a.id !== 'sales'))

  return (
    <div className="space-y-3" data-testid="app-invoice-areas" data-mode={mode}>
      <p className="px-1 text-sm text-zinc-600">{subtitle}</p>
      {mode === 'steps' && steps && (
        <>
          <section className={HERO} data-testid="app-invoices-hero">
            <div className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-white/10" aria-hidden="true" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-white/70">{tr('app.beforeFirstInvoice')}</p>
                <p className="mt-1 text-[22px] font-bold leading-tight">{tr('app.inv.stepsDone').replace('{done}', String(doneCount)).replace('{total}', String(totalSteps))}</p>
              </div>
              {setupHref && <Gear href={setupHref} label={tr('app.inv.setupTitle')} />}
            </div>
            <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-white/20" aria-hidden="true">
              <div className="h-full rounded-full bg-white" style={{ width: `${totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0}%` }} />
            </div>
          </section>

          {stepsLeft > 0 && (
            <section aria-label={tr('app.beforeFirstInvoice')} data-testid="app-setup-steps" className="overflow-hidden rounded-[18px] border border-zinc-200 bg-white">
              {steps.map((step, i) => {
                const body = (
                  <>
                    <span
                      className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2', step.done ? 'border-zinc-700 bg-zinc-700 text-white' : 'border-zinc-400')}
                      aria-hidden="true"
                    >
                      {step.done && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold leading-snug text-zinc-900">{step.label}</span>
                      <span className="mt-0.5 block text-xs font-medium text-zinc-500">
                        {step.required ? tr('invoices.setupRequired') : tr('invoices.setupOptional')}{step.done ? ` · ${tr('app.inv.done')}` : ''}
                      </span>
                    </span>
                    {step.href && <Chevron />}
                  </>
                )
                return (
                  <div key={step.id}>
                    {i > 0 && <div className="ml-[52px] h-px bg-zinc-200" />}
                    {step.href ? (
                      <Link href={step.href} data-testid={`app-setup-step-${step.id}`} className="flex min-h-[56px] items-center gap-3 px-4 py-3">{body}</Link>
                    ) : (
                      <div data-testid={`app-setup-step-${step.id}`} className="flex min-h-[56px] items-center gap-3 px-4 py-3">{body}</div>
                    )}
                  </div>
                )
              })}
            </section>
          )}

          {newInvoiceHref && (
            <Link href={newInvoiceHref} data-testid="app-invoices-new" className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[14px] bg-zinc-200 px-4 text-[15px] font-semibold text-zinc-900">
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              {tr('app.inv.newInvoice')}
            </Link>
          )}
        </>
      )}

      {mode === 'summary' && summary && (
        <section className={HERO} data-testid="app-invoices-hero">
          <div className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-white/10" aria-hidden="true" />
          <div className="relative flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-white/70">{tr('app.inv.owed')}</p>
              <p data-testid="app-invoices-owed" className="mt-1 text-[30px] font-bold leading-[1.1] tracking-tight tabular-nums">{summary.owed[0]}</p>
              {summary.owed.slice(1).map(line => (
                <p key={line} className="text-xl font-semibold leading-tight text-white/85 tabular-nums">{line}</p>
              ))}
            </div>
            {setupHref && <Gear href={setupHref} label={tr('app.inv.setupTitle')} />}
          </div>
          <div className="relative mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-white/[0.12] px-3 py-2">
              <p className="text-[11px] text-white/70">{tr('app.inv.paidSoFar')}</p>
              <p className="text-[15px] font-bold tabular-nums">{summary.paid}</p>
            </div>
            <div className="rounded-xl bg-white/[0.12] px-3 py-2">
              <p className="text-[11px] text-white/70">{tr('app.inv.overdue')}</p>
              <p className="text-[15px] font-bold tabular-nums">{summary.overdue}</p>
            </div>
          </div>
          {newInvoiceHref && (
            <Link href={newInvoiceHref} data-testid="app-invoices-new" className="relative mt-3 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[14px] bg-white px-4 text-[15px] font-bold text-zinc-900">
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              {tr('app.inv.newInvoice')}
            </Link>
          )}
        </section>
      )}

      {mode === 'summary' && (
        <>
          <div className="flex items-baseline justify-between px-1 pt-1">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.09em] text-zinc-500">{tr('app.inv.latest')}</h2>
            {salesCount > 0 && (
              <Link href={seeAllHref} data-testid="app-invoices-see-all" className="text-[13px] font-semibold text-zinc-700">
                {tr('app.inv.seeAll').replace('{n}', String(salesCount))}
              </Link>
            )}
          </div>
          <section data-testid="app-invoices-latest" className="overflow-hidden rounded-[18px] border border-zinc-200 bg-white">
            {latest.length === 0 ? (
              <p className="px-4 py-5 text-sm text-zinc-500">{tr('app.inv.noInvoices')}</p>
            ) : (
              latest.map((inv, i) => (
                <Link
                  key={inv.id}
                  href={inv.href}
                  className={cn('grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3', i > 0 && 'border-t border-zinc-200')}
                >
                  <span className="truncate text-[15px] font-semibold text-zinc-900">{inv.customer}</span>
                  <span className="text-right text-[15px] font-bold tabular-nums text-zinc-900">{inv.amountLabel}</span>
                  <span className="truncate text-xs text-zinc-500">{inv.number} · {inv.dateLabel}</span>
                  <AppStatusPill tone={inv.tone} className="justify-self-end">{inv.status}</AppStatusPill>
                </Link>
              ))
            )}
          </section>
        </>
      )}

      {linkAreas.length > 0 && (
        <>
          {mode !== 'links' && <h2 className="px-1 pt-1 text-[11px] font-bold uppercase tracking-[0.09em] text-zinc-500">{tr('app.inv.alsoHere')}</h2>}
          <section aria-label={tr('app.yourInvoicing')} className="overflow-hidden rounded-[18px] border border-zinc-200 bg-white">
            {linkAreas.map((area, i) => (
              <Link
                key={area.id}
                href={area.href}
                data-testid={`app-area-${area.id}`}
                className={cn('flex min-h-[52px] items-center gap-3 px-4', i > 0 && 'border-t border-zinc-200')}
              >
                <span className="flex-1 text-[15px] font-semibold text-zinc-900">{tr(area.labelKey)}</span>
                <span className="text-[15px] text-zinc-500">{area.count}</span>
                <Chevron />
              </Link>
            ))}
          </section>
        </>
      )}
    </div>
  )
}

/**
 * The way back from an area (Customers, Sales...) to the list, with the area's name. `action` is the area's one main button
 * (a round "+" for a new invoice or a new expense); the page passes it already drawn.
 */
export function AppAreaHeader({ backLabel, backHref = '/portal/invoices', title, action }: { backLabel: string; backHref?: string; title: string; action?: ReactNode }) {
  return (
    <div data-testid="app-area-header" className="-mt-1 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Link href={backHref} aria-label={backLabel} className="-ml-2 flex h-11 items-center gap-0.5 pr-2 text-[15px] font-medium text-zinc-600">
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          {backLabel}
        </Link>
        <span className="text-zinc-300" aria-hidden="true">/</span>
        <h1 className="truncate text-[17px] font-semibold text-zinc-900">{title}</h1>
      </div>
      {action}
    </div>
  )
}
