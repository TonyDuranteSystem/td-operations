'use client'

import { useState } from 'react'
import { Check, ChevronDown, MapPin } from 'lucide-react'
import type { JourneyStep } from '@/lib/flows/flow-progress'

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
  docsHint: string
}

export function FlowStageJourney({
  title,
  steps,
  shipping,
}: {
  title: string
  steps: JourneyStep[]
  /** All copy is pre-resolved server-side, so this component is locale-agnostic. */
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
                      <p className="mt-1 text-xs text-zinc-500">{shipping.docsHint}</p>
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
