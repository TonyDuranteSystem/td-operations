/**
 * Lifecycle Timeline — event assembly from CRM data.
 * Pure function: takes raw query results, returns sorted timeline events.
 * Used by both lead detail and contact detail pages.
 */

export type TimelineEventType =
  | 'lead_created' | 'lead_converted' | 'call_completed'
  | 'offer_created' | 'offer_viewed' | 'offer_superseded'
  | 'email_sent' | 'email_opened'
  | 'contract_signed'
  | 'activation_created' | 'payment_confirmed'
  | 'wizard_started' | 'wizard_progress' | 'wizard_completed'
  | 'sd_created'
  | 'payment_recorded'

export type TimelineColor = 'gray' | 'blue' | 'green' | 'amber' | 'purple' | 'indigo' | 'emerald' | 'sky' | 'red'

export interface TimelineEvent {
  date: string            // ISO timestamp
  type: TimelineEventType
  color: TimelineColor
  title: string
  detail?: string
  sourceId?: string       // for deduplication
}

// ── Input types (loose, from Supabase queries) ──

interface LeadInput {
  created_at: string
  status?: string
  call_date?: string | null
  converted_to_contact_id?: string | null
  updated_at?: string
}

interface OfferInput {
  token: string
  status: string
  created_at: string
  viewed_at?: string | null
  version?: number | null
  superseded_by?: string | null
}

interface CallSummaryInput {
  created_at: string
  meeting_name?: string
  duration_seconds?: number
}

interface EmailTrackingInput {
  id: string
  subject?: string
  created_at: string
  first_opened_at?: string | null
}

interface ContractInput {
  offer_token: string
  signed_at?: string | null
}

interface ActivationInput {
  id: string
  status: string
  created_at: string
  payment_confirmed_at?: string | null
  amount?: number | null
  currency?: string | null
}

interface WizardInput {
  id: string
  current_step?: number | null
  status?: string | null
  created_at: string
  updated_at?: string
  completed_at?: string | null
}

interface ServiceDeliveryInput {
  id: string
  service_type?: string | null
  service_name?: string | null
  status?: string | null
  created_at: string
}

interface PaymentInput {
  id: string
  description?: string | null
  amount?: number | null
  status?: string | null
  created_at: string
}

// ── Assembly ──

export interface TimelineInput {
  lead?: LeadInput | null
  offers?: OfferInput[]
  callSummary?: CallSummaryInput | null
  emailTracking?: EmailTrackingInput[]
  contracts?: ContractInput[]
  activations?: ActivationInput[]
  wizardProgress?: WizardInput[]
  serviceDeliveries?: ServiceDeliveryInput[]
  payments?: PaymentInput[]
}

export function assembleTimeline(input: TimelineInput): TimelineEvent[] {
  const events: TimelineEvent[] = []

  // Lead
  if (input.lead) {
    events.push({
      date: input.lead.created_at,
      type: 'lead_created',
      color: 'gray',
      title: 'Lead created',
      detail: input.lead.status ? `Status: ${input.lead.status}` : undefined,
    })
    if (input.lead.converted_to_contact_id && input.lead.updated_at) {
      events.push({
        date: input.lead.updated_at,
        type: 'lead_converted',
        color: 'green',
        title: 'Lead converted to Contact',
      })
    }
  }

  // Call
  if (input.callSummary) {
    const mins = input.callSummary.duration_seconds
      ? Math.round(input.callSummary.duration_seconds / 60)
      : null
    events.push({
      date: input.callSummary.created_at,
      type: 'call_completed',
      color: 'gray',
      title: 'Call completed',
      detail: [input.callSummary.meeting_name, mins ? `${mins} min` : null].filter(Boolean).join(' — '),
    })
  } else if (input.lead?.call_date) {
    events.push({
      date: new Date(input.lead.call_date).toISOString(),
      type: 'call_completed',
      color: 'gray',
      title: 'Call completed',
    })
  }

  // Offers (all versions)
  for (const o of input.offers ?? []) {
    const vLabel = o.version && o.version > 1 ? ` v${o.version}` : ''
    events.push({
      date: o.created_at,
      type: 'offer_created',
      color: 'blue',
      title: `Offer${vLabel} created`,
      detail: `Status: ${o.status}`,
      sourceId: `offer-${o.token}`,
    })
    if (o.viewed_at) {
      events.push({
        date: o.viewed_at,
        type: 'offer_viewed',
        color: 'amber',
        title: `Offer${vLabel} viewed by client`,
        sourceId: `offer-viewed-${o.token}`,
      })
    }
    if (o.superseded_by) {
      events.push({
        date: o.created_at, // approximate — no separate superseded_at timestamp
        type: 'offer_superseded',
        color: 'gray',
        title: `Offer${vLabel} superseded`,
        detail: `Replaced by ${o.superseded_by}`,
        sourceId: `offer-superseded-${o.token}`,
      })
    }
  }

  // Email tracking
  for (const e of input.emailTracking ?? []) {
    events.push({
      date: e.created_at,
      type: 'email_sent',
      color: 'sky',
      title: 'Email sent',
      detail: e.subject || undefined,
      sourceId: `email-${e.id}`,
    })
    if (e.first_opened_at) {
      events.push({
        date: e.first_opened_at,
        type: 'email_opened',
        color: 'sky',
        title: 'Email first opened',
        sourceId: `email-opened-${e.id}`,
      })
    }
  }

  // Contracts
  for (const c of input.contracts ?? []) {
    if (c.signed_at) {
      events.push({
        date: c.signed_at,
        type: 'contract_signed',
        color: 'green',
        title: 'Contract signed',
        sourceId: `contract-${c.offer_token}`,
      })
    }
  }

  // Activations
  for (const a of input.activations ?? []) {
    events.push({
      date: a.created_at,
      type: 'activation_created',
      color: 'amber',
      title: 'Activation started',
      detail: `Status: ${a.status}`,
      sourceId: `activation-${a.id}`,
    })
    if (a.payment_confirmed_at) {
      const amt = a.amount != null
        ? `${a.currency === 'EUR' ? '€' : '$'}${a.amount.toLocaleString('en-US')}`
        : null
      events.push({
        date: a.payment_confirmed_at,
        type: 'payment_confirmed',
        color: 'emerald',
        title: 'Payment confirmed',
        detail: amt || undefined,
        sourceId: `payment-confirmed-${a.id}`,
      })
    }
  }

  // Wizard
  for (const w of input.wizardProgress ?? []) {
    events.push({
      date: w.created_at,
      type: 'wizard_started',
      color: 'purple',
      title: 'Onboarding wizard started',
      sourceId: `wizard-${w.id}`,
    })
    if (w.current_step && w.current_step > 1 && w.updated_at && w.status !== 'completed') {
      events.push({
        date: w.updated_at,
        type: 'wizard_progress',
        color: 'purple',
        title: `Wizard reached step ${w.current_step}`,
        sourceId: `wizard-step-${w.id}`,
      })
    }
    if (w.status === 'completed' && (w.completed_at || w.updated_at)) {
      events.push({
        date: w.completed_at || w.updated_at!,
        type: 'wizard_completed',
        color: 'green',
        title: 'Onboarding wizard completed',
        sourceId: `wizard-done-${w.id}`,
      })
    }
  }

  // Service Deliveries
  for (const sd of input.serviceDeliveries ?? []) {
    events.push({
      date: sd.created_at,
      type: 'sd_created',
      color: 'indigo',
      title: `Service: ${sd.service_name || sd.service_type || 'Unknown'}`,
      detail: sd.status ? `Status: ${sd.status}` : undefined,
      sourceId: `sd-${sd.id}`,
    })
  }

  // Payments
  for (const p of input.payments ?? []) {
    if (p.status === 'Paid' || p.status === 'paid') {
      events.push({
        date: p.created_at,
        type: 'payment_recorded',
        color: 'emerald',
        title: 'Payment recorded',
        detail: [
          p.amount != null ? `$${p.amount.toLocaleString('en-US')}` : null,
          p.description,
        ].filter(Boolean).join(' — '),
        sourceId: `payment-${p.id}`,
      })
    }
  }

  // Sort chronologically (oldest first)
  events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  return events
}
