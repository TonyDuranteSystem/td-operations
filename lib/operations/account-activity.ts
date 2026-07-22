/**
 * Unified activity feed for account and contact detail pages.
 *
 * Merges events from multiple tables into a single sorted timeline.
 * Two entry points: getAccountActivity (account-centric) and
 * getContactActivity (contact-centric, uses contact_id filter on all tables
 * that carry it, with optional account_id fallback for tables that don't).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
// This feed is CLIENT-VISIBLE: 'wizard' events are whitelisted in
// lib/portal/journey-events.ts and rendered verbatim in the portal chat Log
// tab, so these titles must never contain an internal wizard_type code.
import { wizardLabelFor } from "@/lib/portal/wizard-labels"

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActivityEventType =
  | 'offer'
  | 'payment'
  | 'activation'
  | 'service'
  | 'wizard'
  | 'document'
  | 'task'
  | 'action'
  | 'message'

export interface ActivityEvent {
  id: string
  timestamp: string
  type: ActivityEventType
  title: string
  body?: string
  /** Which DB table this event originated from */
  source: string
}

export interface GetActivityOpts {
  /** Max total events returned after merge + sort. Default 200. */
  limit?: number
}

// ─── Account-centric fetch ───────────────────────────────────────────────────

export async function getAccountActivity(
  accountId: string,
  opts?: GetActivityOpts & { contactIds?: string[] },
): Promise<ActivityEvent[]> {
  const perTable = opts?.limit ?? 200
  const contactIds = opts?.contactIds ?? []

  // Build portal_messages filter: include all contacts linked to this account
  const msgFilter = contactIds.length > 0
    ? `account_id.eq.${accountId},contact_id.in.(${contactIds.join(',')})`
    : `account_id.eq.${accountId}`

  const [offersRes, paymentsRes, sdsRes, wizardsRes, tasksRes, docsRes, actionsRes, messagesRes] =
    await Promise.all([
      supabaseAdmin
        .from('offers')
        .select('id, token, status, contract_type, client_name, created_at, viewed_at, updated_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('payments')
        .select('id, description, amount, amount_currency, invoice_number, created_at, sent_at, paid_date')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('service_deliveries')
        .select('id, service_name, service_type, stage_history, status, created_at')
        .eq('account_id', accountId)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('wizard_progress')
        .select('id, wizard_type, status, created_at, updated_at')
        .eq('account_id', accountId)
        .order('updated_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('tasks')
        .select('id, task_title, status, created_at, completed_date')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('documents')
        .select('id, file_name, document_type_name, created_at, processed_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(perTable),
      // action_log: skip pure DB-trigger noise; keep human/system operational entries
      supabaseAdmin
        .from('action_log')
        .select('id, actor, action_type, summary, created_at')
        .eq('account_id', accountId)
        .not('summary', 'is', null)
        .neq('actor', 'db-trigger')
        .not('action_type', 'like', '%_cron%')
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('portal_messages')
        .select('id, message, created_at')
        .or(msgFilter)
        .eq('sender_type', 'client')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(perTable),
    ])

  // pending_activations: no account_id column — resolve via offer tokens
  const offerTokens = (offersRes.data ?? []).map((o) => o.token).filter(Boolean)
  const pendingActivations = await fetchPendingActivations(offerTokens)

  return buildEvents(
    offersRes.data ?? [],
    paymentsRes.data ?? [],
    sdsRes.data ?? [],
    wizardsRes.data ?? [],
    tasksRes.data ?? [],
    docsRes.data ?? [],
    actionsRes.data ?? [],
    messagesRes.data ?? [],
    pendingActivations,
    opts?.limit ?? 200,
  )
}

// ─── Contact-centric fetch ───────────────────────────────────────────────────

export async function getContactActivity(
  contactId: string,
  opts?: GetActivityOpts & { accountIds?: string[] },
): Promise<ActivityEvent[]> {
  const perTable = opts?.limit ?? 200
  const accountIds = opts?.accountIds ?? []

  // All listed tables have both contact_id and account_id columns.
  // When accountIds are known, broaden the filter to catch account-level events
  // (e.g., invoices created for the company rather than the individual).
  const broadFilter = accountIds.length > 0
    ? `contact_id.eq.${contactId},account_id.in.(${accountIds.join(',')})`
    : `contact_id.eq.${contactId}`

  const [offersRes, paymentsRes, sdsRes, wizardsRes, tasksRes, docsRes, actionsRes, messagesRes] =
    await Promise.all([
      supabaseAdmin
        .from('offers')
        .select('id, token, status, contract_type, client_name, created_at, viewed_at, updated_at')
        .or(broadFilter)
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('payments')
        .select('id, description, amount, amount_currency, invoice_number, created_at, sent_at, paid_date')
        .or(broadFilter)
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('service_deliveries')
        .select('id, service_name, service_type, stage_history, status, created_at')
        .or(broadFilter)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('wizard_progress')
        .select('id, wizard_type, status, created_at, updated_at')
        .or(broadFilter)
        .order('updated_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('tasks')
        .select('id, task_title, status, created_at, completed_date')
        .or(broadFilter)
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('documents')
        .select('id, file_name, document_type_name, created_at, processed_at')
        .or(broadFilter)
        .order('created_at', { ascending: false })
        .limit(perTable),
      supabaseAdmin
        .from('action_log')
        .select('id, actor, action_type, summary, created_at')
        .or(broadFilter)
        .not('summary', 'is', null)
        .neq('actor', 'db-trigger')
        .not('action_type', 'like', '%_cron%')
        .order('created_at', { ascending: false })
        .limit(perTable),
      // portal_messages: contact_id is the natural key here
      supabaseAdmin
        .from('portal_messages')
        .select('id, message, created_at')
        .eq('contact_id', contactId)
        .eq('sender_type', 'client')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(perTable),
    ])

  const offerTokens = (offersRes.data ?? []).map((o) => o.token).filter(Boolean)
  const pendingActivations = await fetchPendingActivations(offerTokens)

  return buildEvents(
    offersRes.data ?? [],
    paymentsRes.data ?? [],
    sdsRes.data ?? [],
    wizardsRes.data ?? [],
    tasksRes.data ?? [],
    docsRes.data ?? [],
    actionsRes.data ?? [],
    messagesRes.data ?? [],
    pendingActivations,
    opts?.limit ?? 200,
  )
}

// ─── pending_activations helper (no account_id column) ───────────────────────

type PaRow = {
  offer_token: string
  signed_at: string | null
  payment_confirmed_at: string | null
  activated_at: string | null
  payment_method: string | null
}

async function fetchPendingActivations(offerTokens: string[]): Promise<PaRow[]> {
  if (offerTokens.length === 0) return []
  const { data } = await supabaseAdmin
    .from('pending_activations')
    .select('offer_token, signed_at, payment_confirmed_at, activated_at, payment_method')
    .in('offer_token', offerTokens)
  return data ?? []
}

// ─── Stage history expansion ──────────────────────────────────────────────────
//
// Two formats exist in the DB:
//
// New format (advanceServiceDelivery):
//   { to_stage, from_stage, advanced_at, to_order?, from_order?, notes?, advanced_by? }
//
// Old format (lease_signed / ad-hoc entries):
//   { event, note, at }
//
// Both are normalised into a single shape here so callers don't need to branch.

function expandStageHistory(raw: unknown, serviceName: string): ActivityEvent[] {
  if (!Array.isArray(raw)) return []
  const events: ActivityEvent[] = []

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>

    // New format
    if (typeof e.advanced_at === 'string' && typeof e.to_stage === 'string') {
      events.push({
        id: `sd-stage-${serviceName}-${e.to_stage}-${e.advanced_at}`,
        timestamp: e.advanced_at,
        type: 'service',
        title: `${serviceName} → ${e.to_stage}`,
        body: typeof e.from_stage === 'string' ? `from ${e.from_stage}` : undefined,
        source: 'service_deliveries',
      })
      continue
    }

    // Old format
    if (typeof e.at === 'string') {
      const label = typeof e.event === 'string'
        ? e.event.replace(/_/g, ' ')
        : 'Stage updated'
      const note = typeof e.note === 'string' ? e.note : null
      events.push({
        id: `sd-event-${serviceName}-${e.at}`,
        timestamp: e.at,
        type: 'service',
        title: `${serviceName} — ${label}`,
        body: note ?? undefined,
        source: 'service_deliveries',
      })
    }
  }

  return events
}

// ─── Event builder (pure) ────────────────────────────────────────────────────

type OfferRow = {
  id: string
  token: string
  status: string | null
  contract_type: string | null
  client_name: string | null
  created_at: string
  viewed_at: string | null
  updated_at: string
}
type PaymentRow = {
  id: string
  description: string | null
  amount: number | null
  amount_currency: string | null
  invoice_number: string | null
  created_at: string
  sent_at: string | null
  paid_date: string | null
}
type SdRow = {
  id: string
  service_name: string | null
  service_type: string | null
  stage_history: unknown
  status: string | null
  created_at: string
}
type WizardRow = {
  id: string
  wizard_type: string
  status: string
  created_at: string
  updated_at: string
}
type TaskRow = {
  id: string
  task_title: string | null
  status: string | null
  created_at: string
  completed_date: string | null
}
type DocRow = {
  id: string
  file_name: string
  document_type_name: string | null
  created_at: string
  processed_at: string | null
}
type ActionRow = {
  id: string
  actor: string | null
  action_type: string
  summary: string | null
  created_at: string
}
type MessageRow = {
  id: string
  message: string | null
  created_at: string
}

/** Statuses that mean the client has signed. Derived from live DB values. */
const OFFER_SIGNED_STATUSES = new Set(['signed', 'completed'])

function buildEvents(
  offers: OfferRow[],
  payments: PaymentRow[],
  sds: SdRow[],
  wizards: WizardRow[],
  tasks: TaskRow[],
  docs: DocRow[],
  actions: ActionRow[],
  messages: MessageRow[],
  pendingActivations: PaRow[],
  limit: number,
): ActivityEvent[] {
  const events: ActivityEvent[] = []

  // Offers
  for (const o of offers) {
    events.push({
      id: `offer-created-${o.id}`,
      timestamp: o.created_at,
      type: 'offer',
      title: `Offer created${o.contract_type ? ` — ${o.contract_type}` : ''}`,
      body: o.client_name ?? undefined,
      source: 'offers',
    })
    if (o.viewed_at) {
      events.push({
        id: `offer-viewed-${o.id}`,
        timestamp: o.viewed_at,
        type: 'offer',
        title: 'Offer viewed by client',
        source: 'offers',
      })
    }
    if (o.status && OFFER_SIGNED_STATUSES.has(o.status)) {
      const pa = pendingActivations.find((p) => p.offer_token === o.token)
      const signedAt = pa?.signed_at ?? o.updated_at
      events.push({
        id: `offer-signed-${o.id}`,
        timestamp: signedAt,
        type: 'activation',
        title: 'Contract signed',
        body: o.contract_type ?? undefined,
        source: 'pending_activations',
      })
    }
  }

  // Pending activations
  for (const pa of pendingActivations) {
    if (pa.payment_confirmed_at) {
      events.push({
        id: `pa-paid-${pa.offer_token}`,
        timestamp: pa.payment_confirmed_at,
        type: 'payment',
        title: 'Payment confirmed',
        body: pa.payment_method ?? undefined,
        source: 'pending_activations',
      })
    }
    if (pa.activated_at) {
      events.push({
        id: `pa-activated-${pa.offer_token}`,
        timestamp: pa.activated_at,
        type: 'activation',
        title: 'Services activated',
        source: 'pending_activations',
      })
    }
  }

  // Payments
  for (const p of payments) {
    const inv = p.invoice_number ? ` — ${p.invoice_number}` : ''
    const amountBody = p.amount != null ? `${p.amount_currency ?? ''} ${p.amount}`.trim() : undefined
    events.push({
      id: `payment-created-${p.id}`,
      timestamp: p.created_at,
      type: 'payment',
      title: `Invoice created${inv}`,
      body: p.description ?? undefined,
      source: 'payments',
    })
    if (p.sent_at) {
      events.push({
        id: `payment-sent-${p.id}`,
        timestamp: p.sent_at,
        type: 'payment',
        title: `Invoice sent${inv}`,
        body: amountBody,
        source: 'payments',
      })
    }
    if (p.paid_date) {
      // paid_date is a DATE (no time component). Use noon UTC to avoid timezone
      // ambiguity when sorting — the exact minute doesn't matter for a payment date.
      events.push({
        id: `payment-paid-${p.id}`,
        timestamp: `${p.paid_date}T12:00:00.000Z`,
        type: 'payment',
        title: `Payment received${inv}`,
        body: amountBody,
        source: 'payments',
      })
    }
  }

  // Service deliveries + stage history (both formats)
  for (const sd of sds) {
    const name = sd.service_name ?? sd.service_type ?? 'Service'
    events.push({
      id: `sd-created-${sd.id}`,
      timestamp: sd.created_at,
      type: 'service',
      title: `Service started — ${name}`,
      source: 'service_deliveries',
    })
    events.push(...expandStageHistory(sd.stage_history, name))
  }

  // Wizard progress
  for (const w of wizards) {
    events.push({
      id: `wizard-started-${w.id}`,
      timestamp: w.created_at,
      type: 'wizard',
      title: `Wizard started — ${wizardLabelFor(w.wizard_type).en}`,
      source: 'wizard_progress',
    })
    if (w.status === 'submitted' && w.updated_at !== w.created_at) {
      events.push({
        id: `wizard-submitted-${w.id}`,
        timestamp: w.updated_at,
        type: 'wizard',
        title: `Wizard submitted — ${wizardLabelFor(w.wizard_type).en}`,
        source: 'wizard_progress',
      })
    }
  }

  // Tasks
  for (const t of tasks) {
    events.push({
      id: `task-created-${t.id}`,
      timestamp: t.created_at,
      type: 'task',
      title: `Task created — ${t.task_title ?? 'Task'}`,
      source: 'tasks',
    })
    if (t.completed_date) {
      events.push({
        id: `task-completed-${t.id}`,
        // completed_date is a DATE column — use noon UTC (same rationale as paid_date)
        timestamp: `${t.completed_date}T12:00:00.000Z`,
        type: 'task',
        title: `Task completed — ${t.task_title ?? 'Task'}`,
        source: 'tasks',
      })
    }
  }

  // Documents
  for (const d of docs) {
    events.push({
      id: `doc-${d.id}`,
      timestamp: d.processed_at ?? d.created_at,
      type: 'document',
      title: `Document uploaded — ${d.document_type_name ?? d.file_name}`,
      source: 'documents',
    })
  }

  // Action log (human / operational entries — db-trigger and cron filtered server-side)
  for (const a of actions) {
    if (!a.summary) continue
    events.push({
      id: `action-${a.id}`,
      timestamp: a.created_at,
      type: 'action',
      title: a.summary,
      body: a.actor ?? undefined,
      source: 'action_log',
    })
  }

  // Portal messages (client only, deleted_at filtered server-side)
  for (const m of messages) {
    const text = m.message ?? ''
    events.push({
      id: `msg-${m.id}`,
      timestamp: m.created_at,
      type: 'message',
      title: 'Client message',
      body: text.length > 80 ? `${text.slice(0, 80)}…` : text || undefined,
      source: 'portal_messages',
    })
  }

  // Deduplicate by id, sort newest-first, cap at limit
  const seen = new Set<string>()
  return events
    .filter((e) => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return true
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit)
}
