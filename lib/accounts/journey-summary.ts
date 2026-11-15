/**
 * The one line the Account journey card shows while it is closed (Antonio, 2026-11-14, dev job b3b013cd).
 *
 * The header says where the client IS right now, in words: "Active client · 4 forms submitted", or the one
 * thing that is stuck. It is NOT built from the six steps: about half of the active clients carry an expired
 * offer, so their Offer and Signed steps are grey even though the client is perfectly active. The steps stay
 * inside the card; this only reads the few steps that say something is waiting, plus the forms and the account.
 *
 * Pure (no React, no database) so it is tested on its own. The component builds the inputs from what it already
 * derives for the open card, so the closed line and the open card never disagree.
 */

/** A step only carries a flag when it holds real dates, so an old client never looks "stuck" for lack of a timestamp. */
export type JourneyFlag = 'awaiting_payment' | 'onboarding_not_started'

export interface JourneyStepLite {
  status: 'done' | 'current' | 'pending' | 'issue'
  flag?: JourneyFlag
  /** Days since signing (awaiting_payment) or since payment (onboarding_not_started). */
  days?: number
}

export interface JourneyFormLite {
  label: string
  status: 'submitted' | 'in_progress' | 'pending'
}

export type JourneyTone = 'good' | 'info' | 'warn' | 'neutral'

export interface JourneyHeaderSummary {
  tone: JourneyTone
  label: string
  detail: string
}

export interface JourneyHeaderInput {
  steps: JourneyStepLite[]
  forms: JourneyFormLite[]
  portalTier: string | null
  accountType: string | null
  accountStatus: string | null | undefined
}

/** Accounts that are over: nothing is "waiting" on them, the header just says the status. */
const FINISHED_STATUSES = new Set(['Closed', 'Cancelled'])

const dayWord = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

const formsSubmittedText = (n: number) => (n > 0 ? `${n} form${n === 1 ? '' : 's'} submitted` : '')

/** "A, B" or "A, B +2 more": the header is one line, so a long list is cut. */
function namesOf(forms: JourneyFormLite[]): string {
  const names = forms.map((f) => f.label)
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
}

const join = (parts: string[]) => parts.filter(Boolean).join(' · ')

export function journeyHeaderSummary(input: JourneyHeaderInput): JourneyHeaderSummary {
  const { steps, forms, portalTier, accountType, accountStatus } = input
  const submittedText = formsSubmittedText(forms.filter((f) => f.status === 'submitted').length)
  const inProgress = forms.filter((f) => f.status === 'in_progress')
  const notStarted = forms.filter((f) => f.status === 'pending')

  if (accountStatus && FINISHED_STATUSES.has(accountStatus)) {
    return { tone: 'neutral', label: accountStatus, detail: submittedText }
  }

  const payment = steps.find((s) => s.flag === 'awaiting_payment' && s.status !== 'done')
  if (payment) {
    return {
      tone: 'warn',
      label: 'Waiting for payment',
      detail: payment.days !== undefined ? `${dayWord(payment.days)} since signing` : 'Signed, payment not in yet',
    }
  }

  // An active-tier client has finished onboarding as far as the system is concerned: a missing form record is
  // not "onboarding not started". (25 active clients today are paid, activated and have no form records.)
  const onboarding = portalTier === 'active' ? undefined : steps.find((s) => s.flag === 'onboarding_not_started' && s.status !== 'done')
  if (onboarding) {
    return {
      tone: onboarding.status === 'issue' ? 'warn' : 'info',
      label: 'Onboarding not started',
      detail: onboarding.days !== undefined ? `${dayWord(onboarding.days)} since payment` : 'Paid, waiting for the client',
    }
  }

  if (notStarted.length > 0) {
    return {
      tone: 'warn',
      label: notStarted.length === 1 ? 'Form not started' : `${notStarted.length} forms not started`,
      detail: join([namesOf(notStarted), submittedText]),
    }
  }

  if (inProgress.length > 0) {
    return {
      tone: 'info',
      label: inProgress.length === 1 ? 'Form in progress' : `${inProgress.length} forms in progress`,
      detail: join([namesOf(inProgress), submittedText]),
    }
  }

  if (portalTier === 'formation') return { tone: 'info', label: 'Formation in progress', detail: submittedText }
  if (portalTier === 'onboarding') return { tone: 'info', label: 'Onboarding in progress', detail: submittedText }

  const statusAllowsActive = !accountStatus || accountStatus === 'Active'
  if (portalTier === 'active' && accountType === 'Client' && statusAllowsActive) {
    return { tone: 'good', label: 'Active client', detail: submittedText }
  }

  return { tone: 'neutral', label: accountStatus || 'Not active yet', detail: submittedText }
}
