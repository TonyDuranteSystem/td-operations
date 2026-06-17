'use client'

import Link from 'next/link'
import { CheckCircle, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FormationTrackerStep } from '@/lib/portal/formation-progress'

interface FormationProgressTrackerProps {
  steps: FormationTrackerStep[]
  locale: 'en' | 'it'
  /** Where the "complete the wizard" action links (lead-anchored). */
  wizardHref: string
  /** Where the "sign your SS-4" action links. */
  signHref: string
  title: string
}

const ACTION_LABEL: Record<'en' | 'it', string> = {
  en: 'Action required',
  it: 'Azione richiesta',
}

/**
 * Client-facing Company Formation progress tracker. Driven entirely by the
 * formation SD's pipeline stages (client_label / client_label_it). Client-action
 * stages that are CURRENT glow amber with an "Action required" link to the
 * wizard (Payment Confirmed) or the signing page (SS-4 Prepared). EN/IT.
 */
export function FormationProgressTracker({ steps, locale, wizardHref, signHref, title }: FormationProgressTrackerProps) {
  return (
    <div className="bg-white rounded-xl border shadow-sm p-6">
      <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-5">{title}</h2>
      <div className="space-y-1">
        {steps.map((step, i) => {
          const href = step.action === 'wizard' ? wizardHref : step.action === 'sign' ? signHref : null
          const clickable = step.isActionRequired && href
          const body = (
            <div
              className={cn(
                'flex items-center gap-3 rounded-lg px-2 py-2 transition-colors',
                step.isActionRequired && 'bg-amber-50 shadow-[0_0_0_1px_rgb(252_211_77)] ring-2 ring-amber-300/60',
                clickable && 'hover:bg-amber-100',
              )}
            >
              {/* Status dot */}
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                  step.status === 'completed' && 'bg-emerald-100 text-emerald-600',
                  step.status === 'current' && (step.isActionRequired ? 'bg-amber-400 text-white animate-pulse' : 'bg-blue-500 text-white'),
                  step.status === 'upcoming' && 'bg-zinc-100 text-zinc-400',
                )}
              >
                {step.status === 'completed' ? (
                  <CheckCircle className="h-4 w-4" />
                ) : (
                  <span className="text-xs font-semibold">{i + 1}</span>
                )}
              </span>

              {/* Label + action hint */}
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    'text-sm',
                    step.status === 'upcoming' ? 'text-zinc-400' : 'font-medium text-zinc-900',
                  )}
                >
                  {step.label}
                </p>
                {step.isActionRequired && (
                  <p className="text-xs font-medium text-amber-700">{ACTION_LABEL[locale]}</p>
                )}
              </div>

              {clickable && <ArrowRight className="h-4 w-4 shrink-0 text-amber-600" />}
            </div>
          )

          return clickable ? (
            <Link key={step.stageName} href={href!} className="block">
              {body}
            </Link>
          ) : (
            <div key={step.stageName}>{body}</div>
          )
        })}
      </div>
    </div>
  )
}
