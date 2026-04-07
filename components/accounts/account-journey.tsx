'use client'

import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// --- Types ---

type JourneyStepStatus = 'done' | 'current' | 'pending' | 'issue'

interface JourneyStep {
  label: string
  status: JourneyStepStatus
  detail?: string
  tooltip?: string[]  // lines shown on hover
}

export interface AccountJourneyProps {
  offer: {
    token: string
    status: string
    contract_type: string | null
    created_at: string
    view_count?: number
    viewed_at?: string | null
    cost_summary?: Array<{ label: string; total?: string }> | null
  } | null
  pendingActivation: {
    signed_at: string | null
    payment_confirmed_at: string | null
    payment_method: string | null
    activated_at: string | null
    status: string | null
  } | null
  wizardProgress: {
    status: string
    current_step: number
    wizard_type: string
    updated_at: string
  } | null
  serviceDeliveries: Array<{
    status: string | null
    stage: string | null
    pipeline: string | null
    service_name: string | null
  }>
  accountType: string | null
  portalTier: string | null
}

// --- Constants ---

const JOURNEY_STEP_STYLES: Record<JourneyStepStatus, { dot: string; text: string }> = {
  done: { dot: 'bg-emerald-500', text: 'text-emerald-700' },
  current: { dot: 'bg-blue-500 ring-4 ring-blue-100', text: 'text-blue-700' },
  pending: { dot: 'bg-zinc-200', text: 'text-zinc-400' },
  issue: { dot: 'bg-amber-500 ring-4 ring-amber-100', text: 'text-amber-700' },
}

// --- Helpers ---

function daysBetween(from: string | Date, to: Date = new Date()): number {
  const start = typeof from === 'string' ? new Date(from) : from
  const diffMs = to.getTime() - start.getTime()
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

// --- Derivation logic ---

function deriveAccountJourneySteps(props: AccountJourneyProps): JourneyStep[] {
  const { offer, pendingActivation, wizardProgress, serviceDeliveries, accountType, portalTier } = props
  const steps: JourneyStep[] = []

  // 1. Offer step
  if (!offer) {
    steps.push({ label: 'Offer', status: 'pending', tooltip: ['No offer created yet'] })
  } else if (['signed', 'completed'].includes(offer.status)) {
    const tooltip = [`Token: ${offer.token}`, `Type: ${offer.contract_type ?? 'N/A'}`]
    if (offer.view_count) tooltip.push(`Viewed ${offer.view_count} time${offer.view_count > 1 ? 's' : ''}`)
    if (offer.viewed_at) tooltip.push(`Last viewed: ${formatDateTime(offer.viewed_at)}`)
    tooltip.push(`Created: ${formatShortDate(offer.created_at)}`)
    steps.push({ label: 'Offer', status: 'done', detail: offer.contract_type ?? undefined, tooltip })
  } else if (['sent', 'viewed'].includes(offer.status)) {
    const tooltip = [`Token: ${offer.token}`, `Status: ${offer.status.toUpperCase()}`]
    if (offer.status === 'viewed') {
      tooltip.push(`Viewed ${offer.view_count ?? 1} time${(offer.view_count ?? 1) > 1 ? 's' : ''}`)
      if (offer.viewed_at) tooltip.push(`Last opened: ${formatDateTime(offer.viewed_at)}`)
    } else {
      tooltip.push('Client has NOT opened the offer yet')
    }
    const daysOut = daysBetween(offer.created_at)
    tooltip.push(`Sent ${daysOut}d ago (${formatShortDate(offer.created_at)})`)
    if (offer.contract_type) tooltip.push(`Type: ${offer.contract_type}`)
    if (offer.cost_summary) {
      const totals = offer.cost_summary.filter(g => g.total).map(g => `${g.label}: ${g.total}`)
      if (totals.length > 0) tooltip.push(...totals)
    }
    steps.push({
      label: 'Offer',
      status: 'current',
      detail: offer.status === 'viewed' ? `Viewed (${offer.view_count ?? 1}x)` : 'Sent',
      tooltip,
    })
  } else if (offer.status === 'draft') {
    steps.push({
      label: 'Offer',
      status: 'current',
      detail: 'Draft',
      tooltip: [`Token: ${offer.token}`, 'Status: DRAFT — not yet sent to client', `Created: ${formatShortDate(offer.created_at)}`],
    })
  } else {
    steps.push({ label: 'Offer', status: 'pending' })
  }

  // 2. Signed step
  const offerDone = offer && ['signed', 'completed'].includes(offer.status)
  const offerSentOrViewed = offer && ['sent', 'viewed'].includes(offer.status)

  if (pendingActivation?.signed_at) {
    const tooltip = [`Signed: ${formatDateTime(pendingActivation.signed_at)}`]
    const daysSince = daysBetween(pendingActivation.signed_at)
    if (daysSince > 0) tooltip.push(`${daysSince}d ago`)
    steps.push({ label: 'Signed', status: 'done', detail: formatShortDate(pendingActivation.signed_at), tooltip })
  } else if (offerDone && !pendingActivation) {
    steps.push({ label: 'Signed', status: 'done', tooltip: ['Contract signed (via offer completion)'] })
  } else if (offerSentOrViewed) {
    const tooltip = ['Waiting for client to sign the contract']
    if (offer?.status === 'viewed') {
      tooltip.push(`Client has viewed the offer ${offer.view_count ?? 1} time${(offer.view_count ?? 1) > 1 ? 's' : ''}`)
    }
    steps.push({ label: 'Signed', status: 'pending', detail: 'Awaiting signature', tooltip })
  } else {
    steps.push({ label: 'Signed', status: 'pending' })
  }

  // 3. Paid step
  const signedStep = steps[1]
  const isSigned = signedStep.status === 'done'

  if (pendingActivation?.payment_confirmed_at) {
    const tooltip = [
      `Paid: ${formatDateTime(pendingActivation.payment_confirmed_at)}`,
      `Method: ${pendingActivation.payment_method ?? 'N/A'}`,
    ]
    steps.push({ label: 'Paid', status: 'done', detail: pendingActivation.payment_method ?? undefined, tooltip })
  } else if (isSigned && pendingActivation?.signed_at) {
    const daysSinceSigning = daysBetween(pendingActivation.signed_at)
    const tooltip = [`Signed ${daysSinceSigning}d ago`, 'Waiting for payment confirmation']
    if (daysSinceSigning > 7) {
      tooltip.push('⚠ Payment overdue — follow up with client')
      steps.push({ label: 'Paid', status: 'issue', detail: `${daysSinceSigning}d since signing`, tooltip })
    } else {
      steps.push({ label: 'Paid', status: 'current', detail: 'Awaiting payment', tooltip })
    }
  } else if (isSigned) {
    steps.push({ label: 'Paid', status: 'current', detail: 'Awaiting payment', tooltip: ['Waiting for payment confirmation'] })
  } else {
    steps.push({ label: 'Paid', status: 'pending' })
  }

  // 4. Onboarding step
  const isPaid = steps[2].status === 'done'

  if (wizardProgress?.status === 'submitted') {
    steps.push({
      label: 'Onboarding',
      status: 'done',
      detail: wizardProgress.wizard_type,
      tooltip: [`Wizard: ${wizardProgress.wizard_type}`, 'Status: Submitted', `Last updated: ${formatDateTime(wizardProgress.updated_at)}`],
    })
  } else if (wizardProgress?.status === 'in_progress') {
    steps.push({
      label: 'Onboarding',
      status: 'current',
      detail: `Step ${wizardProgress.current_step}`,
      tooltip: [`Wizard: ${wizardProgress.wizard_type}`, `Progress: Step ${wizardProgress.current_step}`, `Last activity: ${formatDateTime(wizardProgress.updated_at)}`],
    })
  } else if (isPaid && !wizardProgress) {
    const daysSincePaid = pendingActivation?.payment_confirmed_at
      ? daysBetween(pendingActivation.payment_confirmed_at)
      : 0
    if (daysSincePaid > 3) {
      steps.push({
        label: 'Onboarding',
        status: 'issue',
        detail: `Not started (${daysSincePaid}d)`,
        tooltip: [`Paid ${daysSincePaid}d ago but wizard not started`, '⚠ Send a reminder to the client'],
      })
    } else {
      steps.push({
        label: 'Onboarding',
        status: 'current',
        detail: 'Not started',
        tooltip: ['Payment confirmed — waiting for client to start the onboarding wizard'],
      })
    }
  } else {
    steps.push({ label: 'Onboarding', status: 'pending' })
  }

  // 5. Services step
  const activeServices = serviceDeliveries.filter(sd => sd.status === 'active')
  const completedServices = serviceDeliveries.filter(sd => sd.status === 'completed' || sd.stage === 'Closing')

  if (completedServices.length > 0) {
    const tooltip = ['Completed services:']
    completedServices.forEach(sd => tooltip.push(`  • ${sd.service_name ?? 'Service'} — ${sd.stage ?? 'Complete'}`))
    if (activeServices.length > 0) {
      tooltip.push('Active services:')
      activeServices.forEach(sd => tooltip.push(`  • ${sd.service_name ?? 'Service'} — ${sd.stage ?? 'In progress'}`))
    }
    steps.push({ label: 'Services', status: 'done', detail: 'Complete', tooltip })
  } else if (activeServices.length > 0) {
    const tooltip = [`${activeServices.length} active service${activeServices.length > 1 ? 's' : ''}:`]
    activeServices.forEach(sd => tooltip.push(`  • ${sd.service_name ?? 'Service'} — ${sd.stage ?? 'In progress'}`))
    const firstActive = activeServices[0]
    steps.push({ label: 'Services', status: 'current', detail: firstActive.stage ?? undefined, tooltip })
  } else if (serviceDeliveries.length > 0) {
    const tooltip = [`${serviceDeliveries.length} service${serviceDeliveries.length > 1 ? 's' : ''} (not yet active)`]
    steps.push({ label: 'Services', status: 'current', detail: serviceDeliveries[0].stage ?? undefined, tooltip })
  } else {
    steps.push({ label: 'Services', status: 'pending', tooltip: ['No service deliveries created yet'] })
  }

  // 6. Active step
  const isActivePortal = portalTier && ['active', 'full'].includes(portalTier)
  const isClient = accountType === 'Client'

  if (isActivePortal && isClient) {
    steps.push({
      label: 'Active',
      status: 'done',
      tooltip: [`Account type: ${accountType}`, `Portal tier: ${portalTier}`, 'Client is fully active'],
    })
  } else if (portalTier === 'onboarding') {
    steps.push({
      label: 'Active',
      status: 'current',
      detail: 'Onboarding',
      tooltip: [`Account type: ${accountType ?? 'N/A'}`, 'Portal tier: onboarding', 'Client still going through onboarding'],
    })
  } else if (activeServices.length > 0) {
    steps.push({
      label: 'Active',
      status: 'current',
      tooltip: [`Account type: ${accountType ?? 'N/A'}`, 'Has active services but not fully onboarded yet'],
    })
  } else {
    steps.push({ label: 'Active', status: 'pending' })
  }

  return steps
}

// --- Tooltip Component ---

function StepTooltip({ lines, visible }: { lines: string[]; visible: boolean }) {
  if (!visible || lines.length === 0) return null
  return (
    <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-zinc-900 text-white text-[11px] rounded-lg px-3 py-2.5 shadow-lg pointer-events-none">
      <div className="space-y-0.5">
        {lines.map((line, i) => (
          <p key={i} className={cn(line.startsWith('⚠') ? 'text-amber-300 font-medium' : 'text-zinc-200')}>
            {line}
          </p>
        ))}
      </div>
      {/* Arrow */}
      <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-zinc-900" />
    </div>
  )
}

// --- Component ---

export function AccountJourney(props: AccountJourneyProps) {
  const steps = deriveAccountJourneySteps(props)
  const [hoveredStep, setHoveredStep] = useState<string | null>(null)

  // Only show if there's an offer (no journey to show for accounts with no offers)
  if (!props.offer) return null

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center gap-1.5 mb-3">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">
          Account Journey
        </h3>
      </div>

      {/* Desktop horizontal */}
      <div className="hidden sm:flex items-start gap-0">
        {steps.map((step, i) => {
          const styles = JOURNEY_STEP_STYLES[step.status]
          const isHovered = hoveredStep === step.label
          return (
            <div
              key={step.label}
              className="flex-1 flex flex-col items-center relative group cursor-pointer"
              onMouseEnter={() => setHoveredStep(step.label)}
              onMouseLeave={() => setHoveredStep(null)}
            >
              {/* Connector line */}
              {i > 0 && (
                <div
                  className={cn(
                    'absolute top-[11px] right-1/2 h-0.5 w-full',
                    steps[i - 1].status === 'done' ? 'bg-emerald-500' : 'bg-zinc-200'
                  )}
                />
              )}
              {/* Dot */}
              <div
                className={cn(
                  'relative z-10 w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0 transition-transform',
                  styles.dot,
                  isHovered && 'scale-125'
                )}
              >
                {step.status === 'done' && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                )}
                {step.status === 'current' && (
                  <div className="w-2 h-2 rounded-full bg-white" />
                )}
                {step.status === 'issue' && (
                  <span className="text-white text-[10px] font-bold">!</span>
                )}
              </div>
              {/* Label */}
              <span className={cn('text-xs font-medium mt-1.5', styles.text)}>
                {step.label}
              </span>
              {/* Detail */}
              {step.detail && (
                <span
                  className={cn(
                    'text-[10px] mt-0.5 max-w-[80px] text-center truncate',
                    step.status === 'issue' ? 'text-amber-600' : 'text-muted-foreground'
                  )}
                >
                  {step.detail}
                </span>
              )}
              {/* Tooltip on hover */}
              {step.tooltip && (
                <StepTooltip lines={step.tooltip} visible={isHovered} />
              )}
            </div>
          )
        })}
      </div>

      {/* Mobile vertical */}
      <div className="sm:hidden space-y-2">
        {steps.map((step) => {
          const styles = JOURNEY_STEP_STYLES[step.status]
          return (
            <div
              key={step.label}
              className="flex items-center gap-3"
              onClick={() => setHoveredStep(hoveredStep === step.label ? null : step.label)}
            >
              <div
                className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center shrink-0',
                  styles.dot
                )}
              >
                {step.status === 'done' && (
                  <CheckCircle2 className="h-3 w-3 text-white" />
                )}
                {step.status === 'current' && (
                  <div className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
                {step.status === 'issue' && (
                  <span className="text-white text-[9px] font-bold">!</span>
                )}
              </div>
              <span className={cn('text-sm font-medium', styles.text)}>
                {step.label}
              </span>
              {step.detail && (
                <span className="text-xs text-muted-foreground ml-auto">
                  {step.detail}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
