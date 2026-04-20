'use client'

import { useState, useCallback } from 'react'
import { CheckCircle2, Download, Clock, AlertTriangle } from 'lucide-react'
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
  /** All wizard submissions for this account */
  allWizards?: Array<{
    wizard_type: string
    status: string
    current_step: number
    updated_at: string
    data: Record<string, unknown> | null
  }>
  serviceDeliveries: Array<{
    status: string | null
    stage: string | null
    pipeline: string | null
    service_name: string | null
  }>
  accountType: string | null
  portalTier: string | null
  /** Account status (Active, Inactive, Lead, Prospect) */
  accountStatus?: string | null
  /** Account creation date — used for existing clients without offers */
  accountCreatedAt?: string | null
  /** Whether setup payment has been made (derived from payments) */
  hasSetupPayment?: boolean
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
  const { offer, pendingActivation, wizardProgress, serviceDeliveries, accountType, portalTier, accountStatus, accountCreatedAt, hasSetupPayment } = props
  const steps: JourneyStep[] = []

  // Detect if this is an existing client without an offer (pre-offer-system)
  const isExistingClient = !offer && accountType === 'Client' && accountStatus === 'Active'

  // 1. Offer step
  if (!offer && isExistingClient) {
    steps.push({ label: 'Offer', status: 'done', detail: 'Pre-system', tooltip: ['Client onboarded before offer system', accountCreatedAt ? `Account created: ${formatShortDate(accountCreatedAt)}` : 'Creation date: N/A'] })
  } else if (!offer) {
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

  if (isExistingClient) {
    steps.push({ label: 'Signed', status: 'done', detail: 'Pre-system', tooltip: ['Contract completed before offer system'] })
  } else if (pendingActivation?.signed_at) {
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

  if (isExistingClient && hasSetupPayment) {
    steps.push({ label: 'Paid', status: 'done', tooltip: ['Setup payment confirmed'] })
  } else if (isExistingClient) {
    steps.push({ label: 'Paid', status: 'done', detail: 'Pre-system', tooltip: ['Payment completed before offer system'] })
  } else if (pendingActivation?.payment_confirmed_at) {
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

  if (isExistingClient && !wizardProgress) {
    // Existing client — check if they have an onboarding service delivery
    const onboardingSd = serviceDeliveries.find(sd => sd.service_name?.toLowerCase().includes('onboarding'))
    if (onboardingSd && onboardingSd.status === 'completed') {
      steps.push({ label: 'Onboarding', status: 'done', tooltip: ['Onboarding completed'] })
    } else if (onboardingSd) {
      steps.push({ label: 'Onboarding', status: 'current', detail: onboardingSd.stage ?? 'In progress', tooltip: [`Onboarding: ${onboardingSd.stage ?? 'In progress'}`] })
    } else {
      steps.push({ label: 'Onboarding', status: 'done', detail: 'Pre-system', tooltip: ['Client was onboarded before portal wizard'] })
    }
  } else if (wizardProgress?.status === 'submitted') {
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

  // Show journey for any active account or any account with an offer
  const hasServices = props.serviceDeliveries.length > 0
  const isActive = props.accountStatus === 'Active'
  if (!props.offer && !hasServices && !isActive) return null

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

      {/* Wizard Submissions */}
      <WizardCards wizards={props.allWizards ?? []} serviceDeliveries={props.serviceDeliveries} />
    </div>
  )
}

// --- Wizard helpers ---

const WIZARD_LABELS: Record<string, string> = {
  onboarding: 'Onboarding',
  formation: 'LLC Formation',
  banking: 'Banking',
  banking_payset: 'Banking (Payset EUR)',
  banking_relay: 'Banking (Relay USD)',
  itin: 'ITIN Application',
  tax: 'Tax Return',
  closure: 'Company Closure',
}

// One active SD can expect MULTIPLE wizards — Banking Fintech sets up both
// Payset (EUR) and Relay (USD), so each needs its own card with its own
// status instead of collapsing them into a single "Banking" row.
const WIZARD_EXPECTED: Record<string, string[]> = {
  'Banking Fintech': ['banking_payset', 'banking_relay'],
  'ITIN': ['itin'],
  'ITIN Renewal': ['itin'],
  'Tax Return': ['tax'],
  'Company Formation': ['formation'],
  'Company Closure': ['closure'],
}

interface WizardCardEntry {
  wizard_type: string
  label: string
  status: 'submitted' | 'in_progress' | 'pending'
  updated_at: string | null
  data: Record<string, unknown> | null
}

function WizardCards({ wizards, serviceDeliveries }: {
  wizards: AccountJourneyProps['allWizards']
  serviceDeliveries: AccountJourneyProps['serviceDeliveries']
}) {
  // Build list: completed wizards + pending wizards (from services that expect a wizard)
  const entries: WizardCardEntry[] = []
  const coveredTypes = new Set<string>()

  // Add actual wizard submissions
  for (const w of wizards ?? []) {
    coveredTypes.add(w.wizard_type)
    entries.push({
      wizard_type: w.wizard_type,
      label: WIZARD_LABELS[w.wizard_type] ?? w.wizard_type,
      status: w.status === 'submitted' ? 'submitted' : 'in_progress',
      updated_at: w.updated_at,
      data: w.data,
    })
  }

  // Add pending wizards from active services that expect a wizard but don't have one
  for (const sd of serviceDeliveries) {
    const serviceType = sd.service_name ?? ''
    // Match by exact key OR partial match (service_name includes company name, e.g. "Banking Fintech — ATCOACHING LLC")
    const mappedTypes = WIZARD_EXPECTED[serviceType] ?? Object.entries(WIZARD_EXPECTED).find(([key]) => serviceType.startsWith(key))?.[1]
    if (!mappedTypes || sd.status !== 'active') continue
    for (const mappedType of mappedTypes) {
      if (coveredTypes.has(mappedType)) continue
      coveredTypes.add(mappedType)
      entries.push({
        wizard_type: mappedType,
        label: WIZARD_LABELS[mappedType] ?? mappedType,
        status: 'pending',
        updated_at: null,
        data: null,
      })
    }
  }

  if (entries.length === 0) return null

  // Sort: submitted first, then in_progress, then pending
  const order = { submitted: 0, in_progress: 1, pending: 2 }
  entries.sort((a, b) => order[a.status] - order[b.status])

  return (
    <div className="mt-4 border-t pt-4">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Client Wizard Submissions
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {entries.map((entry) => (
          <WizardCard key={entry.wizard_type} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function WizardCard({ entry }: { entry: WizardCardEntry }) {
  const downloadData = useCallback(() => {
    if (!entry.data || Object.keys(entry.data).length === 0) return
    // Format data as readable text
    const lines: string[] = [`${entry.label} — Submitted Data`, '='.repeat(40), '']
    for (const [key, value] of Object.entries(entry.data)) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      const val = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
      // Skip file paths (storage references)
      if (typeof value === 'string' && value.startsWith('onboarding/')) {
        lines.push(`${label}: [File uploaded]`)
      } else {
        lines.push(`${label}: ${val}`)
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${entry.wizard_type}_data_${new Date().toISOString().split('T')[0]}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [entry])

  const statusConfig = {
    submitted: { icon: CheckCircle2, bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', badge: 'bg-emerald-100 text-emerald-700', label: 'Submitted' },
    in_progress: { icon: Clock, bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', badge: 'bg-blue-100 text-blue-700', label: 'In Progress' },
    pending: { icon: AlertTriangle, bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-700', label: 'Not Started' },
  }

  const config = statusConfig[entry.status]
  const Icon = config.icon

  return (
    <div className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5', config.bg)}>
      <Icon className={cn('h-4 w-4 shrink-0', config.text)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{entry.label}</span>
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', config.badge)}>
            {config.label}
          </span>
        </div>
        {entry.updated_at && (
          <span className="text-[10px] text-muted-foreground">
            {formatShortDate(entry.updated_at)}
          </span>
        )}
      </div>
      {entry.status === 'submitted' && entry.data && Object.keys(entry.data).length > 0 && (
        <button
          onClick={downloadData}
          className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-900 bg-emerald-100 hover:bg-emerald-200 px-2 py-1 rounded transition-colors"
          title="Download submitted data"
        >
          <Download className="h-3 w-3" />
          Export
        </button>
      )}
      {entry.status === 'pending' && (
        <span className="shrink-0 text-[10px] text-amber-600 font-medium">Awaiting client</span>
      )}
    </div>
  )
}
