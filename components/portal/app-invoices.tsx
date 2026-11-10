// The Invoices screens of the CLIENT iPhone app (dev job 056a70d0, Step 3c; docs/systems/client-app.md).
// Drawn only inside the app (the page decides): a short list of areas instead of the website's row of tabs, a card with the
// "before your first invoice" steps that are each a link, and the small header that takes you back to that list from an area.
// Plain server components: links only, no script. Words are passed in already translated.
import Link from 'next/link'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { AppArea } from '@/lib/portal-app/invoices'

export interface AppStep {
  id: string
  label: string
  required: boolean
  done: boolean
  /** Where tapping the step leads; null = not a link (this person cannot open that area). */
  href: string | null
}

export function AppInvoiceAreas({
  subtitle,
  steps,
  stepsLeft,
  areas,
  tr,
}: {
  subtitle: string
  steps: AppStep[] | null
  stepsLeft: number
  areas: AppArea[]
  tr: (key: string) => string
}) {
  return (
    <div className="space-y-4" data-testid="app-invoice-areas">
      <p className="px-1 text-sm text-zinc-600">{subtitle}</p>

      {steps && stepsLeft > 0 && (
        <section aria-label={tr('app.beforeFirstInvoice')} data-testid="app-setup-steps" className="rounded-[18px] border border-amber-300 bg-amber-50 py-1.5">
          <div className="flex items-center justify-between px-4 pb-1 pt-3">
            <h2 className="text-[13px] font-bold uppercase tracking-wide text-amber-800">{tr('app.beforeFirstInvoice')}</h2>
            <span className="rounded-full bg-amber-500 px-2.5 py-0.5 text-xs font-bold text-white">
              {stepsLeft === 1 ? tr('app.stepLeft') : tr('app.stepsLeft').replace('{n}', String(stepsLeft))}
            </span>
          </div>
          {steps.map((step, i) => {
            const body = (
              <>
                <span
                  className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 ${step.done ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-zinc-400'}`}
                  aria-hidden="true"
                >
                  {step.done && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15.5px] font-semibold leading-snug text-zinc-900">{step.label}</span>
                  <span className={`mt-0.5 block text-[12.5px] ${step.required ? 'font-bold text-amber-700' : 'font-medium text-zinc-600'}`}>
                    {step.required ? tr('invoices.setupRequired') : tr('invoices.setupOptional')}
                  </span>
                </span>
                {step.href && <ChevronRight className="h-[18px] w-[18px] shrink-0 text-zinc-500" aria-hidden="true" />}
              </>
            )
            return (
              <div key={step.id}>
                {i > 0 && <div className="ml-[50px] h-px bg-zinc-200" />}
                {step.href ? (
                  <Link href={step.href} data-testid={`app-setup-step-${step.id}`} className="flex min-h-[56px] items-center gap-3 px-4 py-3">
                    {body}
                  </Link>
                ) : (
                  <div data-testid={`app-setup-step-${step.id}`} className="flex min-h-[56px] items-center gap-3 px-4 py-3">{body}</div>
                )}
              </div>
            )
          })}
        </section>
      )}

      <section aria-label={tr('app.yourInvoicing')} className="rounded-[18px] border border-zinc-200 bg-white">
        <h2 className="px-4 pb-1 pt-3 text-[13px] font-bold uppercase tracking-wide text-zinc-600">{tr('app.yourInvoicing')}</h2>
        {areas.map((area, i) => (
          <div key={area.id}>
            {i > 0 && <div className="ml-4 h-px bg-zinc-200" />}
            <Link href={area.href} data-testid={`app-area-${area.id}`} className="flex h-12 items-center gap-3 px-4">
              <span className="flex-1 text-base font-medium text-zinc-900">{tr(area.labelKey)}</span>
              {area.badge > 0 ? (
                <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white" data-testid="app-area-setup-badge">{area.badge}</span>
              ) : area.id !== 'setup' ? (
                <span className="text-[15px] text-zinc-600">{area.count}</span>
              ) : null}
              <ChevronRight className="h-[18px] w-[18px] shrink-0 text-zinc-500" aria-hidden="true" />
            </Link>
          </div>
        ))}
      </section>
    </div>
  )
}

/** The way back from an area (Customers, Sales...) to the list, with the area's name. */
export function AppAreaHeader({ backLabel, backHref = '/portal/invoices', title }: { backLabel: string; backHref?: string; title: string }) {
  return (
    <div data-testid="app-area-header" className="-mt-1 flex items-center gap-2">
      <Link href={backHref} aria-label={backLabel} className="-ml-2 flex h-11 items-center gap-0.5 pr-2 text-[15px] font-medium text-blue-700">
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        {backLabel}
      </Link>
      <span className="text-zinc-300" aria-hidden="true">/</span>
      <h1 className="text-[17px] font-semibold text-zinc-900">{title}</h1>
    </div>
  )
}
