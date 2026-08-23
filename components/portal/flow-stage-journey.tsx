'use client'

import { useState } from 'react'
import { Check, ChevronDown, MapPin, FileText, Download } from 'lucide-react'
import type { JourneyStep } from '@/lib/flows/flow-progress'
import { ItinShippingForm } from './itin-shipping-form'

/**
 * Rich, clickable client-facing flow journey for the portal flow detail page.
 *
 * Unlike the compact horizontal FlowProgressTracker (dashboard summary), this is
 * a vertical list where each stage can be clicked to reveal its client-facing
 * description ("what's happening / what to do"). The current stage is expanded
 * by default. One stage (`shipping.stageName`, e.g. ITIN "Client Signing") also
 * renders a print/sign/mail card with the office address + a document checklist.
 *
 * Built for ITIN (every stage carries a description), but generic over any flow
 * whose JourneySteps carry descriptions. Read-only — the client never advances.
 */

export interface ShippingCard {
  /** stage_name whose expanded panel shows the mailing card. */
  stageName: string
  title: string
  intro: string
  addressLines: string[]
  checklist: string[]
  tracking: string
  /** CAA safety line — mailing an ORIGINAL passport is unrecoverable. */
  passportWarning?: string
  /** Heading above the embedded download list (e.g. "Your documents to print:"). */
  documentsHeading: string
  /** Per-document download button label (e.g. "Download"). */
  downloadLabel: string
  /** The actual prepared documents (W-7 / 1040-NR / Schedule OI) for this SD,
   *  rendered as download links. May be empty if not generated yet. */
  documents: { id: string; file_name: string }[]
  /** When set (the SD is currently at this stage), render the client
   *  shipping-tracking form below the documents — shown only at the live stage. */
  shippingForm?: {
    serviceDeliveryId: string
    initialCourier: string | null
    initialTracking: string | null
  } | null
}

export function FlowStageJourney({
  title,
  steps,
  shipping,
}: {
  title: string
  steps: JourneyStep[]
  /** Card copy is pre-resolved server-side. The embedded ItinShippingForm is
   *  the one exception — it reads the client's language live via context. */
  shipping?: ShippingCard | null
}) {
  // Auto-expand the current stage; let the client toggle any stage open/closed.
  const currentName = steps.find(s => s.state === 'current')?.stageName ?? null
  const [open, setOpen] = useState<Record<string, boolean>>(
    currentName ? { [currentName]: true } : {},
  )

  const toggle = (name: string) => setOpen(prev => ({ ...prev, [name]: !prev[name] }))

  return (
    <div className="bg-white rounded-xl border shadow-sm p-5">
      <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-4">{title}</h2>
      <ol className="relative">
        {steps.map((step, i) => {
          const isOpen = !!open[step.stageName]
          const hasPanel = !!step.description || step.stageName === shipping?.stageName
          const last = i === steps.length - 1
          return (
            <li key={step.stageName} className="relative pl-9 pb-4 last:pb-0">
              {/* Connector line down to the next dot */}
              {!last && (
                <span
                  className={`absolute left-[11px] top-6 bottom-0 w-0.5 ${
                    step.state === 'completed' ? 'bg-emerald-500' : 'bg-zinc-200'
                  }`}
                  aria-hidden
                />
              )}
              {/* Dot */}
              <span className="absolute left-0 top-0.5" aria-hidden>
                {step.state === 'completed' ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                ) : step.state === 'current' ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white ring-4 ring-blue-100 text-[11px]">
                    •
                  </span>
                ) : (
                  <span className="block h-6 w-6 rounded-full border-2 border-zinc-300 bg-white" />
                )}
              </span>

              {hasPanel ? (
                <button
                  type="button"
                  onClick={() => toggle(step.stageName)}
                  aria-expanded={isOpen}
                  className="group flex w-full items-center justify-between gap-2 text-left"
                >
                  <span
                    className={`text-sm ${
                      step.state === 'current'
                        ? 'font-semibold text-blue-700'
                        : step.state === 'completed'
                          ? 'text-zinc-700'
                          : 'text-zinc-500'
                    }`}
                  >
                    {step.label}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform group-hover:text-zinc-600 ${isOpen ? 'rotate-180' : ''}`}
                  />
                </button>
              ) : (
                <span
                  className={`text-sm ${
                    step.state === 'current'
                      ? 'font-semibold text-blue-700'
                      : step.state === 'completed'
                        ? 'text-zinc-700'
                        : 'text-zinc-500'
                  }`}
                >
                  {step.label}
                </span>
              )}

              {hasPanel && isOpen && (
                <div className="mt-2 space-y-3">
                  {step.description && (
                    <p className="text-sm text-zinc-600 leading-relaxed">{step.description}</p>
                  )}

                  {step.stageName === shipping?.stageName && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <MapPin className="h-4 w-4 text-amber-700" />
                        <span className="text-sm font-semibold text-amber-900">{shipping.title}</span>
                      </div>
                      <p className="text-sm text-zinc-700 mb-2">{shipping.intro}</p>
                      <div className="rounded-md border border-amber-200 bg-white px-4 py-3 text-sm text-zinc-800 leading-relaxed">
                        {shipping.addressLines.map((line, j) => (
                          <div key={j} className={j === 0 ? 'font-semibold' : ''}>{line}</div>
                        ))}
                      </div>
                      <ul className="mt-3 space-y-1">
                        {shipping.checklist.map((item, j) => (
                          <li key={j} className="flex items-start gap-2 text-sm text-zinc-700">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" strokeWidth={2.5} />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 text-xs font-medium text-amber-800">{shipping.tracking}</p>
                      {shipping.passportWarning && (
                        <p className="mt-2 rounded-md bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-900">
                          {shipping.passportWarning}
                        </p>
                      )}

                      {shipping.documents.length > 0 && (
                        <div className="mt-4 border-t border-amber-200 pt-3">
                          <div className="mb-2 flex items-center gap-1.5">
                            <FileText className="h-4 w-4 text-amber-700" />
                            <span className="text-sm font-semibold text-amber-900">{shipping.documentsHeading}</span>
                          </div>
                          <ul className="space-y-1.5">
                            {shipping.documents.map(d => (
                              <li key={d.id}>
                                <a
                                  href={`/api/portal/documents/${d.id}`}
                                  className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-white px-3 py-2 hover:bg-amber-50"
                                >
                                  <span className="flex min-w-0 items-center gap-2">
                                    <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
                                    <span className="truncate text-sm text-zinc-800">{d.file_name}</span>
                                  </span>
                                  <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-blue-700">
                                    <Download className="h-3.5 w-3.5" />
                                    {shipping.downloadLabel}
                                  </span>
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {shipping.shippingForm && (
                        <ItinShippingForm
                          serviceDeliveryId={shipping.shippingForm.serviceDeliveryId}
                          initialCourier={shipping.shippingForm.initialCourier}
                          initialTracking={shipping.shippingForm.initialTracking}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
