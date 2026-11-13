/**
 * Recording fake database + scenario table for the Calendly webhook replay (booking engine, Stage 1a).
 *
 * Purpose: run the webhook handler on a booking payload against a fake database and record EVERYTHING it does
 * (every query, every write, every call into the money / referral modules, the log lines and the answer), so that
 * the behaviour of today's code can be saved as a golden baseline and the same payloads replayed against edited code.
 *
 * This file holds NO real data. The real payloads (they contain emails) are read from a folder outside the repo
 * named by BOOKING_REPLAY_DIR and are never committed.
 */

import { createHmac } from 'node:crypto'

export interface Scenario {
  name: string
  mode?: 'auto_create' | 'staging'
  existingLead?: { id: string; status: string; existing_client_contact_id?: string | null } | null
  existingContact?: { id: string; full_name: string; portal_tier: string | null } | null
  hasAccountLink?: boolean
  hasServiceDelivery?: boolean
  referrer?: { id: string; full_name: string } | null
  newLeadId?: string
  leadInsertError?: string
  leadCallsInsertError?: string
  leadCallExists?: boolean
  paidCallThrows?: boolean
  referralThrows?: boolean
  referralCreated?: boolean
}

/** Every scenario is replayed for every payload. Together they reach every branch of the webhook's lead tail. */
export const SCENARIOS: Scenario[] = [
  { name: 'new_person' },
  { name: 'existing_lead_early', existingLead: { id: 'lead-old', status: 'New' } },
  { name: 'existing_lead_late', existingLead: { id: 'lead-old', status: 'Qualified' } },
  { name: 'existing_lead_already_tagged', existingLead: { id: 'lead-old', status: 'Call Scheduled', existing_client_contact_id: 'contact-tag' }, existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: 'active' } },
  { name: 'contact_stub', existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: 'lead' } },
  { name: 'contact_null_tier', existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: null } },
  { name: 'contact_tier_active', existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: 'active' } },
  { name: 'contact_account_link', existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: null }, hasAccountLink: true },
  { name: 'contact_service_delivery', existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: null }, hasServiceDelivery: true },
  { name: 'existing_lead_and_established_contact', existingLead: { id: 'lead-old', status: 'New' }, existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: 'onboarding' } },
  { name: 'referrer_found', referrer: { id: 'referrer-1', full_name: 'Referrer Person' } },
  { name: 'referrer_found_existing_lead', referrer: { id: 'referrer-1', full_name: 'Referrer Person' }, existingLead: { id: 'lead-old', status: 'New' } },
  { name: 'referrer_found_but_referral_not_created', referrer: { id: 'referrer-1', full_name: 'Referrer Person' }, referralCreated: false },
  { name: 'referrer_found_referral_throws', referrer: { id: 'referrer-1', full_name: 'Referrer Person' }, referralThrows: true },
  { name: 'lead_insert_fails', leadInsertError: 'insert failed' },
  { name: 'call_record_fails', leadCallsInsertError: 'lead_calls insert failed' },
  { name: 'call_already_recorded', leadCallExists: true },
  { name: 'paid_call_throws', paidCallThrows: true },
  { name: 'staging_new', mode: 'staging' },
  { name: 'staging_existing_lead', mode: 'staging', existingLead: { id: 'lead-old', status: 'New' }, existingContact: { id: 'contact-1', full_name: 'Existing Contact', portal_tier: 'active' } },
]

export interface QueryRecord {
  seq: number
  table: string
  ops: Array<[string, unknown[]]>
  terminal: string
  kind: 'read' | 'write'
}

export interface Trace {
  queries: QueryRecord[]
  moduleCalls: Array<{ fn: string; args: unknown }>
  logs: string[]
  response: { status: number; body: unknown } | { thrown: string }
}

const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete'])

let current: { scenario: Scenario; trace: Trace; seq: number } | null = null

export function beginRun(scenario: Scenario): Trace {
  const trace: Trace = { queries: [], moduleCalls: [], logs: [], response: { thrown: 'not finished' } }
  current = { scenario, trace, seq: 0 }
  return trace
}

export function endRun(): void {
  current = null
}

export function recordModuleCall(fn: string, args: unknown): void {
  current?.trace.moduleCalls.push({ fn, args: JSON.parse(JSON.stringify(args ?? null)) })
}

export function currentScenario(): Scenario {
  if (!current) throw new Error('no replay run in progress')
  return current.scenario
}

export function recordLog(line: string): void {
  current?.trace.logs.push(line)
}

type Resolved = { data: unknown; error: { message: string } | null }

function resolveQuery(table: string, ops: Array<[string, unknown[]]>, terminal: string): Resolved {
  const sc = current!.scenario
  const names = ops.map((o) => o[0])
  const has = (n: string) => names.includes(n)
  const ilikeCol = ops.find((o) => o[0] === 'ilike')?.[1]?.[0]
  const eqCols = ops.filter((o) => o[0] === 'eq').map((o) => o[1][0])
  const asRows = (rows: unknown[]): Resolved => {
    if (terminal === 'maybeSingle') return { data: rows[0] ?? null, error: null }
    if (terminal === 'single') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } }
    return { data: rows, error: null }
  }
  if (table === 'leads') {
    if (has('insert')) {
      if (sc.leadInsertError) return { data: null, error: { message: sc.leadInsertError } }
      return { data: { id: sc.newLeadId ?? 'lead-new' }, error: null }
    }
    if (has('update')) return { data: null, error: null }
    return asRows(sc.existingLead ? [sc.existingLead] : [])
  }
  if (table === 'contacts') {
    if (ilikeCol === 'referral_code') return asRows(sc.referrer ? [sc.referrer] : [])
    return asRows(sc.existingContact ? [sc.existingContact] : [])
  }
  if (table === 'account_contacts') return asRows(sc.hasAccountLink ? [{ account_id: 'account-1' }] : [])
  if (table === 'service_deliveries') return asRows(sc.hasServiceDelivery ? [{ id: 'sd-1' }] : [])
  if (table === 'lead_calls') {
    if (has('insert')) {
      if (sc.leadCallsInsertError) return { data: null, error: { message: sc.leadCallsInsertError } }
      return { data: { id: 'call-1' }, error: null }
    }
    if (has('update')) return { data: null, error: null }
    if (eqCols.includes('calendly_event_uri')) return asRows(sc.leadCallExists ? [{ id: 'call-existing' }] : [])
    return asRows([])
  }
  if (table === 'app_settings') {
    // the booking switch, set for a whole replay run by BOOKING_REPLAY_SETTING (absent | off | page | live | throws)
    const setting = process.env.BOOKING_REPLAY_SETTING ?? 'absent'
    if (setting === 'throws') throw new Error('settings read failed')
    if (setting === 'error') return { data: null, error: { message: 'settings read failed' } }
    if (setting === 'absent') return asRows([])
    return asRows([{ value: { mode: setting } }])
  }
  if (table === 'webhook_events') {
    if (has('select')) return asRows([{ id: 'event-1' }])
    return { data: null, error: null }
  }
  return asRows([])
}

/** The object that stands in for the supabase client: from(table) returns a chainable, awaitable recorder. */
export function fakeClient() {
  return {
    from(table: string) {
      const run = current
      const rec: QueryRecord = { seq: run ? run.seq++ : -1, table, ops: [], terminal: 'await', kind: 'read' }
      run?.trace.queries.push(rec)
      const builder: Record<string, unknown> = {}
      const chainMethods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'ilike', 'like', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'or', 'contains', 'range', 'filter']
      for (const m of chainMethods) {
        builder[m] = (...args: unknown[]) => {
          rec.ops.push([m, JSON.parse(JSON.stringify(args ?? []))])
          if (WRITE_OPS.has(m)) rec.kind = 'write'
          return builder
        }
      }
      const finish = (terminal: string): Resolved => {
        rec.terminal = terminal
        return resolveQuery(table, rec.ops, terminal)
      }
      builder.maybeSingle = async () => finish('maybeSingle')
      builder.single = async () => finish('single')
      builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => new Promise((resolve) => resolve(finish('await'))).then(onF, onR)
      return builder
    },
  }
}

/** With a secret, the request carries a valid Calendly signature (t=<now>,v1=<hmac>) — Date.now() is whatever the test froze it to. */
export function makeReq(body: unknown, secret?: string) {
  const text = JSON.stringify(body)
  let signature: string | null = null
  if (secret) {
    const t = Math.floor(Date.now() / 1000)
    signature = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${text}`).digest('hex')}`
  }
  return {
    text: async () => text,
    headers: { get: (name: string) => (name.toLowerCase() === 'calendly-webhook-signature' ? signature : null) },
  }
}

/** Writes + module calls + the answer only (the reads and log lines left out): used once new, switched-off code is added. */
export function behaviourView(t: Trace) {
  return {
    writes: t.queries.filter((q) => q.kind === 'write').map((q) => ({ table: q.table, ops: q.ops.filter((o) => o[0] !== 'select') })),
    moduleCalls: t.moduleCalls,
    response: t.response,
  }
}
