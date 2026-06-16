'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Check, ChevronRight } from 'lucide-react'
import type { FlowStep } from '@/lib/flows/flow-progress'

/**
 * Generic client-facing flow progress stepper — the visual language of
 * components/portal/tax-progress-tracker.tsx generalised to ANY flow (Tax
 * Return / State Annual Report / State RA Renewal / …). Takes a ready-made
 * `title` and the steps produced by lib/flows/flow-progress.ts::buildFlowSteps.
 *
 * Completed = filled dot + check, current = highlighted ring, future = empty
 * dot. Horizontally scrollable on small screens; the current step auto-scrolls
 * into view on mount so late-stage clients aren't left staring at a row of
 * completed checks. Scrolls only its own overflow container, never the page.
 */
export function FlowProgressTracker({
  title,
  steps,
  href,
}: {
  title: string
  steps: FlowStep[]
  /** When set, the title links to the flow detail page with a "details" chevron. */
  href?: string
}) {
  const currentRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [])

  return (
    <div className="bg-white rounded-xl border shadow-sm p-5">
      {href ? (
        <Link
          href={href}
          className="group mb-4 flex items-center justify-between gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-800"
        >
          <span>{title}</span>
          <ChevronRight className="h-4 w-4 text-zinc-400 group-hover:text-zinc-700" />
        </Link>
      ) : (
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-4">
          {title}
        </h2>
      )}
      <div className="overflow-x-auto pb-2 -mx-1 px-1">
        <ol className="flex items-start min-w-max" aria-label={title}>
          {steps.map((step, i) => (
            <li
              key={step.stageName}
              ref={step.state === 'current' ? currentRef : undefined}
              className="flex items-start"
            >
              {/* Connector line before every dot except the first */}
              {i > 0 && (
                <div
                  className={`mt-3 h-0.5 w-6 sm:w-9 shrink-0 ${
                    step.state === 'future' ? 'bg-zinc-200' : 'bg-emerald-500'
                  }`}
                  aria-hidden
                />
              )}
              <div className="flex flex-col items-center w-16 sm:w-20">
                {step.state === 'completed' && (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                )}
                {step.state === 'current' && (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white ring-4 ring-blue-100 text-[11px]">
                    {step.icon ?? '•'}
                  </span>
                )}
                {step.state === 'future' && (
                  <span className="h-6 w-6 rounded-full border-2 border-zinc-300 bg-white" />
                )}
                <span
                  className={`mt-1.5 text-center text-[10px] leading-tight ${
                    step.state === 'current'
                      ? 'font-semibold text-blue-700'
                      : step.state === 'completed'
                        ? 'text-zinc-600'
                        : 'text-zinc-400'
                  }`}
                >
                  {step.label}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
