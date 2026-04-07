'use client'

import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// --- Types ---

type JourneyStepStatus = 'done' | 'current' | 'pending' | 'issue'

interface JourneyStep {
  label: string
  status: JourneyStepStatus
  detail?: string
}

export interface AccountJourneyProps {
  offer: {
    token: string
    status: string
    contract_type: string | null
    created_at: string
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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// --- Derivation logic ---

function deriveAccountJourneySteps(props: AccountJourneyProps): JourneyStep[] {
  const { offer, pendingActivation, wizardProgress, serviceDeliveries, accountType, portalTier } = props
  const steps: JourneyStep[] = []

  // 1. Offer step
  if (!offer) {
    steps.push({ label: 'Offer', status: 'pending' })
  } else if (['signed', 'completed'].includes(offer.status)) {
    steps.push({ label: 'Offer', status: 'done', detail: offer.contract_type ?? undefined })
  } else if (['sent', 'viewed'].includes(offer.status)) {
    steps.push({ label: 'Offer', status: 'current', detail: offer.status.charAt(0).toUpperCase() + offer.status.slice(1) })
  } else if (offer.status === 'draft') {
    steps.push({ label: 'Offer', status: 'current', detail: 'Draft' })
  } else {
    steps.push({ label: 'Offer', status: 'pending' })
  }

  // 2. Signed step
  const offerDone = offer && ['signed', 'completed'].includes(offer.status)
  const offerSentOrViewed = offer && ['sent', 'viewed'].includes(offer.status)

  if (pendingActivation?.signed_at) {
    steps.push({ label: 'Signed', status: 'done', detail: formatShortDate(pendingActivation.signed_at) })
  } else if (offerDone && !pendingActivation) {
    steps.push({ label: 'Signed', status: 'done' })
  } else if (offerSentOrViewed) {
    steps.push({ label: 'Signed', status: 'pending', detail: 'Awaiting signature' })
  } else {
    steps.push({ label: 'Signed', status: 'pending' })
  }

  // 3. Paid step
  const signedStep = steps[1]
  const isSigned = signedStep.status === 'done'

  if (pendingActivation?.payment_confirmed_at) {
    steps.push({ label: 'Paid', status: 'done', detail: pendingActivation.payment_method ?? undefined })
  } else if (isSigned && pendingActivation?.signed_at) {
    const daysSinceSigning = daysBetween(pendingActivation.signed_at)
    if (daysSinceSigning > 7) {
      steps.push({ label: 'Paid', status: 'issue', detail: `${daysSinceSigning}d since signing` })
    } else {
      steps.push({ label: 'Paid', status: 'current', detail: 'Awaiting payment' })
    }
  } else if (isSigned) {
    steps.push({ label: 'Paid', status: 'current', detail: 'Awaiting payment' })
  } else {
    steps.push({ label: 'Paid', status: 'pending' })
  }

  // 4. Onboarding step
  const isPaid = steps[2].status === 'done'

  if (wizardProgress?.status === 'submitted') {
    steps.push({ label: 'Onboarding', status: 'done', detail: wizardProgress.wizard_type })
  } else if (wizardProgress?.status === 'in_progress') {
    steps.push({ label: 'Onboarding', status: 'current', detail: `Step ${wizardProgress.current_step}` })
  } else if (isPaid && !wizardProgress) {
    const daysSincePaid = pendingActivation?.payment_confirmed_at
      ? daysBetween(pendingActivation.payment_confirmed_at)
      : 0
    if (daysSincePaid > 3) {
      steps.push({ label: 'Onboarding', status: 'issue', detail: `Not started (${daysSincePaid}d)` })
    } else {
      steps.push({ label: 'Onboarding', status: 'current', detail: 'Not started' })
    }
  } else {
    steps.push({ label: 'Onboarding', status: 'pending' })
  }

  // 5. Services step
  const hasCompleted = serviceDeliveries.some(
    sd => sd.status === 'completed' || sd.stage === 'Closing'
  )
  const hasActive = serviceDeliveries.some(sd => sd.status === 'active')

  if (hasCompleted) {
    steps.push({ label: 'Services', status: 'done', detail: 'Complete' })
  } else if (hasActive) {
    const firstActive = serviceDeliveries.find(sd => sd.status === 'active')
    steps.push({ label: 'Services', status: 'current', detail: firstActive?.stage ?? undefined })
  } else if (serviceDeliveries.length > 0) {
    const first = serviceDeliveries[0]
    steps.push({ label: 'Services', status: 'current', detail: first.stage ?? undefined })
  } else {
    steps.push({ label: 'Services', status: 'pending' })
  }

  // 6. Active step
  const isActivePortal = portalTier && ['active', 'full'].includes(portalTier)
  const isClient = accountType === 'Client'
  const hasActiveServices = hasActive

  if (isActivePortal && isClient) {
    steps.push({ label: 'Active', status: 'done' })
  } else if (portalTier === 'onboarding') {
    steps.push({ label: 'Active', status: 'current', detail: 'Onboarding' })
  } else if (hasActiveServices) {
    steps.push({ label: 'Active', status: 'current' })
  } else {
    steps.push({ label: 'Active', status: 'pending' })
  }

  return steps
}

// --- Component ---

export function AccountJourney(props: AccountJourneyProps) {
  const steps = deriveAccountJourneySteps(props)

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
          return (
            <div key={step.label} className="flex-1 flex flex-col items-center relative group">
              {i > 0 && (
                <div
                  className={cn(
                    'absolute top-[11px] right-1/2 h-0.5 w-full',
                    steps[i - 1].status === 'done' ? 'bg-emerald-500' : 'bg-zinc-200'
                  )}
                />
              )}
              <div
                className={cn(
                  'relative z-10 w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0',
                  styles.dot
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
              <span className={cn('text-xs font-medium mt-1.5', styles.text)}>
                {step.label}
              </span>
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
            </div>
          )
        })}
      </div>

      {/* Mobile vertical */}
      <div className="sm:hidden space-y-2">
        {steps.map((step) => {
          const styles = JOURNEY_STEP_STYLES[step.status]
          return (
            <div key={step.label} className="flex items-center gap-3">
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
