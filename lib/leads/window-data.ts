// Data for the floating lead window (dev job 6fc63c52, phase A).
//
// Pure and read-only: it takes rows already fetched by the route and returns
// exactly what the window draws — the calls, the next action, the offer line
// and the story. Nothing here reads or writes the database.
//
// Phase A limit, on purpose: a lead keeps only ONE call date (a rebooking
// overwrites it) and no booking history exists yet, so the calls shown are
// the recordings that came back (each a Done call) plus the lead's current
// call date as a Scheduled / Not confirmed call when no recording covers it.

import { assembleTimeline, type TimelineEvent } from '@/lib/lifecycle-timeline'
import { todayInNewYork } from '@/lib/leads/list-filters'
import { nyDate, daysBetween } from '@/lib/leads/ny-date'
import { undoOpen, undoHoursLeft, type LeadCallRow, type StatusMoveRow } from '@/lib/leads/lead-calls'

export interface WindowLeadRow {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  language: string | null
  source: string | null
  referrer_name: string | null
  status: string | null
  call_date: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
  existing_client_contact_id: string | null
  converted_to_contact_id: string | null
  owner?: string | null
  follow_up_date?: string | null
}

export interface WindowOfferRow {
  token: string
  status: string
  version: number | null
  created_at: string
  viewed_at: string | null
  view_count: number | null
  superseded_by: string | null
}

export interface WindowCallRow {
  id: string
  meeting_name: string | null
  duration_seconds: number | null
  notes: string | null
  recording_url: string | null
  created_at: string
}

export interface WindowEmailRow { id: string; subject: string | null; created_at: string; first_opened_at: string | null }
export interface WindowContractRow { offer_token: string; signed_at: string | null }
export interface WindowActivationRow {
  id: string
  status: string
  created_at: string
  payment_confirmed_at: string | null
  amount: number | null
  currency: string | null
}

export interface WindowInput {
  lead: WindowLeadRow
  offers: WindowOfferRow[]
  calls: WindowCallRow[]
  /** ids of call rows that have a saved transcript */
  transcriptCallIds: string[]
  emails: WindowEmailRow[]
  contracts: WindowContractRow[]
  activation: WindowActivationRow | null
  /** a live exact-email match to a contact that already has a company */
  isLiveClient: boolean
  /** the lead's own call records (lead_calls); when empty the older recordings + call_date logic is used */
  leadCalls?: LeadCallRow[]
  /** automatic / staff status moves made from calls */
  moves?: StatusMoveRow[]
  now?: Date
}

export type CallState = 'done' | 'scheduled' | 'due_today' | 'not_confirmed' | 'no_show' | 'moved' | 'cancelled'

export interface WindowCall {
  key: string
  title: string
  state: CallState
  chip: string
  /** The date the call was planned for (YYYY-MM-DD), when known. */
  scheduledFor: string | null
  /** When the recording came back (ISO), for a Done call. */
  happenedAt: string | null
  durationMin: number | null
  summary: string | null
  hasTranscript: boolean
  recordingUrl: string | null
  callId: string | null
  /** lead_calls id — the target of staff answers; null for a call that has no record yet */
  rowId: string | null
  bookedAt: string | null
  scheduledStart: string | null
  /** staff may answer 'Did this call happen?' */
  canConfirm: boolean
  confirmedBy: string | null
}

export type StoryGroup = 'calls' | 'offer' | 'messages' | 'other'

export interface WindowStoryEvent {
  date: string
  type: TimelineEvent['type'] | 'call_booked' | 'status_moved'
  color: TimelineEvent['color']
  title: string
  detail?: string
  group: StoryGroup
  /** an automatic move that can still be undone */
  undo?: { moveId: string; hoursLeft: number } | null
  /** set only on email / WhatsApp lines (phase C) */
  channel?: 'email' | 'whatsapp'
  direction?: 'in' | 'out'
  matchReason?: string
  count?: number
}

export interface WindowData {
  lead: {
    id: string
    name: string
    email: string | null
    phone: string | null
    language: string | null
    source: string | null
    referrer: string | null
    status: string | null
    /** index into STAGE_STEPS, or -1 for Lost / Suspended */
    stageIndex: number
    badges: string[]
    createdAt: string
    owner: string | null
    followUpDate: string | null
  }
  nextAction: string
  calls: WindowCall[]
  offer: { line: string; sub: string | null } | null
  notes: string | null
  story: WindowStoryEvent[]
}

export const STAGE_STEPS = ['New', 'Call Scheduled', 'Call Done', 'Offer Sent', 'Negotiating', 'Converted'] as const

export function stageIndexFor(status: string | null): number {
  switch (status) {
    case 'New':
    case 'Contacted':
    case 'Qualified':
      return 0
    case 'Call Scheduled': return 1
    case 'Call Done': return 2
    case 'Offer Sent': return 3
    case 'Negotiating': return 4
    case 'Converted': return 5
    default: return -1
  }
}

// ── dates ────────────────────────────────────────────────────────────────

export { nyDate, daysBetween }

const OFFER_LABEL: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  published: 'Sent',
  viewed: 'Viewed',
  signed: 'Signed',
  completed: 'Completed',
  expired: 'Expired',
  under_discussion: 'Under discussion',
  superseded: 'Replaced',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-11-04' (or an ISO timestamp) as '4 Nov 2026' — the same form the window uses everywhere. */
export function fmtYmd(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ymd
  return `${d} ${MONTHS[m - 1]} ${y}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Plain text from a Circleback summary: no markdown marks, one line, clipped. */
export function clipSummary(text: string | null, max = 420): string | null {
  if (!text) return null
  const clean = text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean
}

// ── calls ────────────────────────────────────────────────────────────────

export function buildCalls(args: {
  leadCallDate: string | null
  recordings: WindowCallRow[]
  transcriptCallIds: string[]
  now?: Date
}): WindowCall[] {
  const today = todayInNewYork(args.now ?? new Date())
  const withText = new Set(args.transcriptCallIds)
  const recs = [...args.recordings].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const planned = args.leadCallDate ? args.leadCallDate.slice(0, 10) : null

  // A recording "covers" the lead's current call date when it came back within
  // a day of it (calls run late, and the recording lands after midnight).
  const coverIndex = planned
    ? recs.findIndex(r => Math.abs(daysBetween(planned, nyDate(r.created_at))) <= 1)
    : -1

  const calls: WindowCall[] = recs.map((r, i) => ({
    key: `rec-${r.id}`,
    title: `Call ${i + 1}`,
    state: 'done' as const,
    chip: 'Done',
    scheduledFor: i === coverIndex ? planned : null,
    happenedAt: r.created_at,
    durationMin: r.duration_seconds ? Math.max(1, Math.round(r.duration_seconds / 60)) : null,
    summary: clipSummary(r.notes),
    hasTranscript: withText.has(r.id),
    recordingUrl: r.recording_url,
    callId: r.id,
    rowId: null,
    bookedAt: null,
    scheduledStart: null,
    canConfirm: false,
    confirmedBy: null,
  }))

  if (planned && coverIndex === -1) {
    const diff = daysBetween(today, planned)
    const state: CallState = diff > 0 ? 'scheduled' : diff === 0 ? 'due_today' : 'not_confirmed'
    calls.push({
      key: 'planned',
      title: `Call ${recs.length + 1}`,
      state,
      chip: state === 'scheduled' ? `Scheduled, in ${plural(diff, 'day', 'days')}` : state === 'due_today' ? 'Due today' : 'Not confirmed',
      scheduledFor: planned,
      happenedAt: null,
      durationMin: null,
      summary: null,
      hasTranscript: false,
      recordingUrl: null,
      callId: null,
      rowId: null,
      bookedAt: null,
      scheduledStart: null,
      canConfirm: false,
      confirmedBy: null,
    })
  }
  return calls
}

/** Calls from the lead's own records (lead_calls). A recording with no record yet is shown as a Done call. */
export function buildCallsFromRows(args: {
  rows: LeadCallRow[]
  recordings: WindowCallRow[]
  transcriptCallIds: string[]
  now?: Date
}): WindowCall[] {
  const today = todayInNewYork(args.now ?? new Date())
  const withText = new Set(args.transcriptCallIds)
  const recById = new Map(args.recordings.map(r => [r.id, r]))
  const linked = new Set(args.rows.map(r => r.call_summary_id).filter((x): x is string => !!x))
  const virtual = args.recordings.filter(r => !linked.has(r.id)).map(r => ({
    id: `rec-${r.id}`, lead_id: '', booked_at: null, scheduled_start: null, scheduled_date: null, state: 'done',
    happened_at: r.created_at, call_summary_id: r.id, calendly_event_uri: null, moved_to: null, source: 'recording',
    confirmed_by: 'recording', created_at: r.created_at,
  } as LeadCallRow))
  const key = (r: LeadCallRow) => r.scheduled_start ?? r.scheduled_date ?? r.happened_at ?? r.created_at
  const rows = [...args.rows, ...virtual].sort((a, b) => key(a).localeCompare(key(b)))

  return rows.map((r, i) => {
    const rec = r.call_summary_id ? recById.get(r.call_summary_id) : undefined
    const planned = r.scheduled_date
    let state: CallState
    let chip: string
    if (r.state === 'done') { state = 'done'; chip = rec || r.confirmed_by === 'recording' ? 'Done' : 'Done, confirmed by staff' }
    else if (r.state === 'no_show') { state = 'no_show'; chip = 'No-show' }
    else if (r.state === 'moved') { state = 'moved'; chip = 'Moved' }
    else if (r.state === 'cancelled') { state = 'cancelled'; chip = 'Cancelled' }
    else if (!planned) { state = 'not_confirmed'; chip = 'Not confirmed' }
    else {
      const diff = daysBetween(today, planned)
      state = diff > 0 ? 'scheduled' : diff === 0 ? 'due_today' : 'not_confirmed'
      chip = state === 'scheduled' ? `Scheduled, in ${plural(diff, 'day', 'days')}` : state === 'due_today' ? 'Due today' : 'Not confirmed'
    }
    return {
      key: `call-${r.id}`,
      title: `Call ${i + 1}`,
      state,
      chip,
      scheduledFor: planned,
      happenedAt: r.happened_at,
      durationMin: rec?.duration_seconds ? Math.max(1, Math.round(rec.duration_seconds / 60)) : null,
      summary: clipSummary(rec?.notes ?? null),
      hasTranscript: rec ? withText.has(rec.id) : false,
      recordingUrl: rec?.recording_url ?? null,
      callId: rec?.id ?? null,
      rowId: r.id.startsWith('rec-') ? null : r.id,
      bookedAt: r.booked_at,
      scheduledStart: r.scheduled_start,
      canConfirm: (state === 'not_confirmed' || state === 'due_today') && !r.id.startsWith('rec-'),
      confirmedBy: r.confirmed_by,
    }
  })
}

// ── offer ────────────────────────────────────────────────────────────────

export function currentOffer(offers: WindowOfferRow[]): WindowOfferRow | null {
  const sorted = [...offers].sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.created_at.localeCompare(a.created_at))
  return sorted.find(o => o.status !== 'superseded') ?? sorted[0] ?? null
}

export function offerSummary(offer: WindowOfferRow | null): { line: string; sub: string | null } | null {
  if (!offer) return null
  const label = OFFER_LABEL[offer.status] ?? offer.status
  const line = `${label}, created ${fmtYmd(offer.created_at)}`
  const views = offer.view_count ?? 0
  const sub = offer.viewed_at
    ? `Viewed ${plural(Math.max(views, 1), 'time', 'times')}, last on ${fmtYmd(offer.viewed_at)}`
    : offer.status === 'sent' || offer.status === 'published' ? 'Not opened yet' : null
  return { line, sub }
}

// ── next action ──────────────────────────────────────────────────────────

export function nextActionText(args: {
  status: string | null
  offer: WindowOfferRow | null
  calls: WindowCall[]
  now?: Date
}): string {
  const today = todayInNewYork(args.now ?? new Date())
  const { status, offer, calls } = args
  const lastCall = calls[calls.length - 1] ?? null

  if (status === 'Converted') return 'Converted. Manage this client from their company page.'
  if (status === 'Lost') return 'Marked lost.'
  if (status === 'Suspended') return 'On hold.'

  if (offer && (offer.status === 'signed')) return 'The offer is signed. Waiting for the payment.'
  if (offer && ['sent', 'published', 'viewed', 'under_discussion'].includes(offer.status)) {
    const last = (offer.viewed_at ?? offer.created_at).slice(0, 10)
    const days = daysBetween(last, today)
    const seen = offer.viewed_at ? `viewed ${plural(Math.max(offer.view_count ?? 0, 1), 'time', 'times')}` : 'not opened yet'
    return `Offer ${seen}. No change for ${plural(Math.max(days, 0), 'day', 'days')}. Follow up.`
  }

  if (lastCall?.state === 'not_confirmed') {
    return 'The call date passed and no recording came back. Check whether it happened.'
  }
  if (lastCall?.state === 'done' && status === 'Call Scheduled') {
    return 'The call happened (a recording came back) but the status still says Call Scheduled. Update it.'
  }
  if (status === 'Call Done' && !offer) return 'The call is done and there is no offer yet. Create the offer.'
  if (lastCall && (lastCall.state === 'scheduled' || lastCall.state === 'due_today') && lastCall.scheduledFor) {
    return lastCall.state === 'due_today' ? 'The call is today.' : `Call planned for ${fmtYmd(lastCall.scheduledFor)}.`
  }
  if (status === 'New') return 'New lead. Confirm the first call.'
  return 'Open the full page for the details.'
}

// ── story ────────────────────────────────────────────────────────────────

const OFFER_TYPES = new Set<TimelineEvent['type']>([
  'offer_created', 'offer_viewed', 'offer_superseded', 'contract_signed', 'activation_created', 'payment_confirmed',
])

export function storyGroup(type: WindowStoryEvent['type']): StoryGroup {
  if (type === 'call_completed' || type === 'call_booked' || type === 'status_moved') return 'calls'
  if (OFFER_TYPES.has(type)) return 'offer'
  return 'other'
}

export function buildStory(input: WindowInput, calls: WindowCall[]): WindowStoryEvent[] {
  const base = assembleTimeline({
    // No synthetic "call completed" from the call date: real calls are added below.
    lead: {
      created_at: input.lead.created_at,
      status: input.lead.status ?? undefined,
      call_date: null,
      converted_to_contact_id: input.lead.converted_to_contact_id,
      updated_at: input.lead.updated_at ?? undefined,
    },
    offers: input.offers.map(o => ({
      token: o.token, status: o.status, created_at: o.created_at, viewed_at: o.viewed_at, version: o.version, superseded_by: o.superseded_by,
    })),
    callSummary: null,
    emailTracking: input.emails,
    contracts: input.contracts,
    activations: input.activation ? [input.activation] : [],
  })

  const callEvents: WindowStoryEvent[] = calls
    .filter(c => c.state === 'done' && c.happenedAt)
    .map(c => ({
      date: c.happenedAt as string,
      type: 'call_completed' as const,
      color: 'purple' as const,
      title: c.callId ? `${c.title} recorded` : `${c.title} confirmed by staff`,
      detail: [c.durationMin ? `${c.durationMin} min` : null, c.summary].filter(Boolean).join('. ') || undefined,
      group: 'calls' as const,
    }))

  const bookedEvents: WindowStoryEvent[] = calls
    .filter(c => c.bookedAt)
    .map(c => ({
      date: c.bookedAt as string,
      type: 'call_booked' as const,
      color: 'sky' as const,
      title: `${c.title} booked`,
      detail: c.scheduledFor ? `For ${fmtYmd(c.scheduledFor)}.${c.state === 'moved' ? ' Moved to a later date.' : ''}` : undefined,
      group: 'calls' as const,
    }))

  const now = input.now ?? new Date()
  const moveEvents: WindowStoryEvent[] = []
  for (const m of input.moves ?? []) {
    const auto = m.reason === 'auto_call_done'
    moveEvents.push({
      date: m.created_at,
      type: 'status_moved',
      color: 'gray',
      title: auto ? `Moved to ${m.to_status} automatically` : `Moved to ${m.to_status} after you confirmed the call`,
      detail: auto ? 'A recording came back for a booked call.' : undefined,
      group: 'calls',
      undo: auto && undoOpen(m, now) ? { moveId: m.id, hoursLeft: undoHoursLeft(m, now) } : null,
    })
    if (m.undone_at) {
      moveEvents.push({
        date: m.undone_at,
        type: 'status_moved',
        color: 'gray',
        title: `Undone: back to ${m.from_status ?? 'the earlier status'}`,
        detail: 'This lead will not be moved automatically again.',
        group: 'calls',
        undo: null,
      })
    }
  }

  const fromTimeline: WindowStoryEvent[] = base
    .filter(e => !(input.leadCalls?.length && e.type === 'call_completed'))
    .map(e => ({ date: e.date, type: e.type, color: e.color, title: e.title, detail: e.detail, group: storyGroup(e.type), undo: null }))

  return [...fromTimeline, ...callEvents, ...bookedEvents, ...moveEvents].sort((a, b) => b.date.localeCompare(a.date))
}

// ── everything ───────────────────────────────────────────────────────────

export function buildLeadWindowData(input: WindowInput): WindowData {
  const calls = input.leadCalls && input.leadCalls.length > 0
    ? buildCallsFromRows({ rows: input.leadCalls, recordings: input.calls, transcriptCallIds: input.transcriptCallIds, now: input.now })
    : buildCalls({ leadCallDate: input.lead.call_date, recordings: input.calls, transcriptCallIds: input.transcriptCallIds, now: input.now })
  const offer = currentOffer(input.offers)
  const badges: string[] = []
  if (input.lead.existing_client_contact_id) badges.push('Existing client')
  else if (input.isLiveClient && input.lead.status !== 'Converted') badges.push('Already a client')

  return {
    lead: {
      id: input.lead.id,
      name: input.lead.full_name,
      email: input.lead.email,
      phone: input.lead.phone,
      language: input.lead.language,
      source: input.lead.source,
      referrer: input.lead.referrer_name,
      status: input.lead.status,
      stageIndex: stageIndexFor(input.lead.status),
      badges,
      createdAt: input.lead.created_at,
      owner: input.lead.owner ?? null,
      followUpDate: input.lead.follow_up_date ?? null,
    },
    nextAction: nextActionText({ status: input.lead.status, offer, calls, now: input.now }),
    calls,
    offer: offerSummary(offer),
    notes: input.lead.notes && input.lead.notes.trim() ? input.lead.notes.trim() : null,
    story: buildStory(input, calls),
  }
}

// ── transcript ───────────────────────────────────────────────────────────

export interface TranscriptLine { time: string; speaker: string; text: string }

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The saved transcript is normally an array of { timestamp (seconds), speaker, text }.
 * One old row holds plain text instead. Anything else yields no lines rather than an error.
 */
export function parseTranscript(raw: unknown, maxLines = 2000): TranscriptLine[] {
  if (typeof raw === 'string') {
    const t = raw.trim()
    return t ? [{ time: '', speaker: '', text: t }] : []
  }
  if (!Array.isArray(raw)) return []
  const lines: TranscriptLine[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text.trim() : ''
    if (!text) continue
    lines.push({
      time: typeof r.timestamp === 'number' ? mmss(r.timestamp) : '',
      speaker: typeof r.speaker === 'string' ? r.speaker : '',
      text,
    })
    if (lines.length >= maxLines) break
  }
  return lines
}
