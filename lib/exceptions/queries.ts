/**
 * P3.5 — Exception Handling Center data queries.
 *
 * Consumed by `app/(dashboard)/exceptions/page.tsx`.
 *
 * Each exception source is a function that returns a typed list of rows.
 * The page renders one section per source with a retry action where
 * applicable.
 *
 * Sources (plan §4 line 640):
 *   1. Partial activations — pending_activations stuck at payment_confirmed.
 *   2. Audit cron findings — dev_tasks with [AUTO] prefix.
 *   3. Failed jobs — job_queue rows with status='failed'.
 *   4. Failed emails — email_queue rows with status='failed'.
 *   5. Webhook events flagged for review.
 *
 * All queries are read-only. Retry actions live in ./actions.ts so the
 * server-component page stays a thin render layer.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface PartialActivationRow {
  id: string
  client_name: string
  client_email: string
  offer_token: string
  amount: number | null
  currency: string | null
  payment_method: string | null
  status: string
  signed_at: string | null
  payment_confirmed_at: string | null
  age_hours: number | null
}

export interface AuditFindingRow {
  id: string
  title: string
  priority: string
  created_at: string
  latest_action: string | null
  latest_result: string | null
  age_hours: number | null
}

export interface FailedJobRow {
  id: string
  job_type: string
  status: string
  attempts: number
  max_attempts: number
  error: string | null
  created_at: string
  account_id: string | null
  age_hours: number | null
}

export interface FailedEmailRow {
  id: string
  to_email: string
  subject: string
  status: string
  retry_count: number
  error_message: string | null
  created_at: string
  account_id: string | null
  age_hours: number | null
}

export interface WebhookReviewRow {
  id: string
  source: string
  event_type: string
  external_id: string | null
  review_status: string
  created_at: string
  age_hours: number | null
}

/** Portal tier drift — a contact has a linked account whose portal_tier
 *  disagrees with the contact's portal_tier. This is the state that hid
 *  Luca Gallacci's half-activated client for hours (contact=onboarding /
 *  account=active). Reconcile via the Reconcile Portal Tier button. */
export interface TierDriftRow {
  contact_id: string
  contact_name: string | null
  contact_email: string | null
  contact_tier: string
  account_id: string
  account_name: string | null
  account_tier: string
  age_hours: number | null
}

/** A job in job_queue reported `status='completed'` but its result summary
 *  contains failure language ("Validation failed", "blocked", "error").
 *  This is the class of bug that hid Luca's 7 failed onboarding_setup jobs
 *  on 2026-04-18 — they all completed with "Validation failed: 1 error(s)"
 *  and no one saw them. Defense layer: Phase A makes this rare (sync
 *  validation catches most at the route), this check makes remaining
 *  handler-level failures visible. */
export interface SilentFailedJobRow {
  id: string
  job_type: string
  status: string
  summary: string | null
  account_id: string | null
  contact_id: string | null
  created_at: string
  completed_at: string | null
  age_hours: number | null
}

/** Staff tasks with no account_id but a contact_id, older than 1h — these
 *  are invisible on account detail pages and easy to lose (the 7 "Wizard
 *  validation failed" tasks for Luca Gallacci 2026-04-18 sat here). Any
 *  "To Do" / "In Progress" task with a person but no company gets surfaced
 *  so staff can either attach it to the right account or close it. */
export interface OrphanTaskRow {
  id: string
  task_title: string
  contact_id: string
  assigned_to: string | null
  priority: string | null
  category: string | null
  status: string | null
  created_at: string
  age_hours: number | null
}

function hoursSince(iso: string | null, nowMs: number = Date.now()): number | null {
  if (!iso) return null
  const diff = nowMs - new Date(iso).getTime()
  return Math.max(0, Math.round(diff / 3_600_000))
}

/**
 * Partial activations = signed + paid but not yet activated.
 * `payment_confirmed` is the canonical stuck state (Abder Wakouz class of
 * bug). `awaiting_payment` is not stuck — included only when old (>48h)
 * because that signals a dropped-payment case worth surfacing.
 */
export async function getPartialActivations(): Promise<PartialActivationRow[]> {
  const { data, error } = await supabaseAdmin
    .from("pending_activations")
    .select("id, client_name, client_email, offer_token, amount, currency, payment_method, status, signed_at, payment_confirmed_at, created_at")
    .in("status", ["payment_confirmed", "awaiting_payment"])
    .is("activated_at", null)
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)

  const now = Date.now()
  return (data ?? [])
    .map(r => {
      const ageHours = hoursSince(r.signed_at ?? r.payment_confirmed_at ?? null, now)
      return {
        id: r.id,
        client_name: r.client_name,
        client_email: r.client_email,
        offer_token: r.offer_token,
        amount: r.amount,
        currency: r.currency,
        payment_method: r.payment_method,
        status: r.status,
        signed_at: r.signed_at,
        payment_confirmed_at: r.payment_confirmed_at,
        age_hours: ageHours,
      }
    })
    // Always surface payment_confirmed (any age). Only surface awaiting_payment
    // if older than 48h — anything fresher is normal in-flight state.
    .filter(r => r.status === "payment_confirmed" || (r.age_hours ?? 0) > 48)
}

export async function getAuditFindings(): Promise<AuditFindingRow[]> {
  const { data, error } = await supabaseAdmin
    .from("dev_tasks")
    .select("id, title, priority, progress_log, created_at")
    .ilike("title", "[AUTO]%")
    .in("status", ["todo", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)

  return (data ?? []).map(r => {
    const log = Array.isArray(r.progress_log) ? r.progress_log : []
    const last = log[log.length - 1] as { action?: string; result?: string } | undefined
    return {
      id: r.id,
      title: r.title,
      priority: r.priority,
      created_at: r.created_at,
      latest_action: last?.action ?? null,
      latest_result: last?.result ?? null,
      age_hours: hoursSince(r.created_at),
    }
  })
}

export async function getFailedJobs(): Promise<FailedJobRow[]> {
  const { data, error } = await supabaseAdmin
    .from("job_queue")
    .select("id, job_type, status, attempts, max_attempts, error, created_at, account_id")
    .eq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)

  return (data ?? []).map(r => ({
    id: r.id,
    job_type: r.job_type,
    status: r.status,
    attempts: r.attempts ?? 0,
    max_attempts: r.max_attempts ?? 3,
    error: r.error,
    created_at: r.created_at,
    account_id: r.account_id,
    age_hours: hoursSince(r.created_at),
  }))
}

export async function getFailedEmails(): Promise<FailedEmailRow[]> {
  const { data, error } = await supabaseAdmin
    .from("email_queue")
    .select("id, to_email, subject, status, retry_count, error_message, created_at, account_id")
    .eq("status", "Failed")
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)

  return (data ?? []).map(r => ({
    id: r.id,
    to_email: r.to_email,
    subject: r.subject,
    status: r.status ?? "Failed",
    retry_count: r.retry_count ?? 0,
    error_message: r.error_message,
    created_at: r.created_at,
    account_id: r.account_id,
    age_hours: hoursSince(r.created_at),
  }))
}

export async function getWebhookReviews(): Promise<WebhookReviewRow[]> {
  const { data, error } = await supabaseAdmin
    .from("webhook_events")
    .select("id, source, event_type, external_id, review_status, created_at")
    .in("review_status", ["failed", "rejected", "pending_review"])
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)

  return (data ?? []).map(r => ({
    id: r.id,
    source: r.source,
    event_type: r.event_type,
    external_id: r.external_id,
    review_status: r.review_status,
    created_at: r.created_at,
    age_hours: hoursSince(r.created_at),
  }))
}

/**
 * Portal tier drift — contact portal_tier ≠ linked account portal_tier.
 *
 * This is the ping-pong state from the Luca Gallacci case (2026-04-18):
 * the onboarding-setup handler promoted contact → active while activate-
 * service kept account → onboarding, leaving the two layers disagreeing.
 * The two operations now both land on 'onboarding' (Tier Model B, commit
 * 2b56168), but this check stays in place to catch any future drift —
 * e.g. a direct SQL edit on either table, or a new operation that writes
 * only one layer.
 *
 * Uses supabase nested-select so one round-trip returns the join.
 */
export async function getTierDrift(): Promise<TierDriftRow[]> {
  const { data, error } = await supabaseAdmin
    .from("account_contacts")
    .select(`
      contact_id,
      account_id,
      contacts:contacts!account_contacts_contact_id_fkey(id, full_name, email, portal_tier, updated_at),
      accounts:accounts!account_contacts_account_id_fkey(id, company_name, portal_tier, status, updated_at)
    `)
    .limit(1000)
  if (error) throw new Error(error.message)

  type LinkRow = {
    contact_id: string
    account_id: string
    contacts: { id: string; full_name: string | null; email: string | null; portal_tier: string | null; updated_at: string | null } | null
    accounts: { id: string; company_name: string | null; portal_tier: string | null; status: string | null; updated_at: string | null } | null
  }
  const rows = (data ?? []) as unknown as LinkRow[]

  // Accounts in these statuses are INTENTIONALLY inactive — the tier mismatch
  // with an active owner is expected and not drift. A closed LLC shouldn't
  // carry an "active" tier just because the owner still owns other companies.
  const INTENDED_INACTIVE_STATUSES = new Set(["Cancelled", "Closed", "Suspended", "Offboarding"])

  return rows
    .filter(r => {
      const ct = r.contacts?.portal_tier
      const at = r.accounts?.portal_tier
      if (!ct || !at || ct === at) return false
      if (r.accounts?.status && INTENDED_INACTIVE_STATUSES.has(r.accounts.status)) return false
      return true
    })
    .map(r => {
      const contactUpdated = r.contacts?.updated_at ?? null
      const accountUpdated = r.accounts?.updated_at ?? null
      const latest = contactUpdated && accountUpdated
        ? (new Date(contactUpdated) > new Date(accountUpdated) ? contactUpdated : accountUpdated)
        : contactUpdated ?? accountUpdated ?? null
      return {
        contact_id: r.contact_id,
        contact_name: r.contacts?.full_name ?? null,
        contact_email: r.contacts?.email ?? null,
        contact_tier: r.contacts?.portal_tier ?? "",
        account_id: r.account_id,
        account_name: r.accounts?.company_name ?? null,
        account_tier: r.accounts?.portal_tier ?? "",
        age_hours: hoursSince(latest),
      }
    })
    .sort((a, b) => (a.age_hours ?? 0) - (b.age_hours ?? 0))
    .slice(0, 50)
}

/**
 * Silent-failed jobs — job_queue rows marked `status='completed'` but whose
 * `result.summary` contains failure indicators. This is how Luca Gallacci's
 * 7 onboarding_setup jobs on 2026-04-18 evaded every monitoring signal:
 * each completed with `result.summary='Validation failed: 1 error(s)'` and
 * the cron moved on. Phase A makes validation errors rare at this layer
 * (they surface at the route now), but the defense stays here so any
 * remaining handler-level failures are visible.
 *
 * Looks only at the last 7 days to keep the payload small.
 */
export async function getSilentFailedJobs(): Promise<SilentFailedJobRow[]> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const { data, error } = await supabaseAdmin
    .from("job_queue")
    .select("id, job_type, status, result, payload, created_at, completed_at")
    .eq("status", "completed")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)

  // Targeted failure phrasing from handler code. We intentionally do NOT
  // match bare "error" / "errors" because successful runs summarize with
  // strings like "23 ok, 0 errors, 2 skipped" — that's a count, not a
  // failure state. The strings below are produced only when a handler
  // early-returned from a real failure path.
  const FAILURE_PATTERNS = /(validation\s+failed|cross-check\s+blocked|OCR\s+cross-check\s+blocked|activation\s+failed|chain\s+failed|unsupported\s+wizard)/i

  type Row = {
    id: string
    job_type: string
    status: string
    result: { summary?: string } | null
    payload: { account_id?: string; contact_id?: string } | null
    created_at: string
    completed_at: string | null
  }
  const rows = (data ?? []) as unknown as Row[]

  return rows
    .filter(r => typeof r.result?.summary === "string" && FAILURE_PATTERNS.test(r.result.summary))
    .map(r => ({
      id: r.id,
      job_type: r.job_type,
      status: r.status,
      summary: r.result?.summary ?? null,
      account_id: r.payload?.account_id ?? null,
      contact_id: r.payload?.contact_id ?? null,
      created_at: r.created_at,
      completed_at: r.completed_at,
      age_hours: hoursSince(r.created_at),
    }))
    .slice(0, 50)
}

/**
 * Orphan tasks — open staff tasks without an account_id but with a
 * contact_id, older than 1 hour. The canonical example is the seven
 * "Wizard validation failed — 2L Consulting LLC" tasks created for
 * Luca Gallacci before his account existed — each had account_id=NULL
 * and was invisible on every account detail page. Phase A makes these
 * rare for wizards (sync validation prevents them), but legacy + other
 * sources (e.g. manual task creation) still produce them.
 */
export async function getOrphanTasks(): Promise<OrphanTaskRow[]> {
  const olderThan = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data, error } = await supabaseAdmin
    .from("tasks")
    .select("id, task_title, contact_id, assigned_to, priority, category, status, created_at")
    .is("account_id", null)
    .not("contact_id", "is", null)
    .in("status", ["To Do", "In Progress"])
    .lt("created_at", olderThan)
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)

  type Row = {
    id: string
    task_title: string
    contact_id: string
    assigned_to: string | null
    priority: string | null
    category: string | null
    status: string | null
    created_at: string
  }
  const rows = (data ?? []) as unknown as Row[]

  return rows.map(r => ({
    id: r.id,
    task_title: r.task_title,
    contact_id: r.contact_id,
    assigned_to: r.assigned_to,
    priority: r.priority,
    category: r.category,
    status: r.status,
    created_at: r.created_at,
    age_hours: hoursSince(r.created_at),
  }))
}

export interface ExceptionsSnapshot {
  partialActivations: PartialActivationRow[]
  auditFindings: AuditFindingRow[]
  failedJobs: FailedJobRow[]
  failedEmails: FailedEmailRow[]
  webhookReviews: WebhookReviewRow[]
  tierDrift: TierDriftRow[]
  silentFailedJobs: SilentFailedJobRow[]
  orphanTasks: OrphanTaskRow[]
  totalCount: number
}

/**
 * One-call fetch for all sources. Pages awaiting this are already inside a
 * React Server Component — running the five queries in parallel beats doing
 * them sequentially on render.
 */
export async function getExceptionsSnapshot(): Promise<ExceptionsSnapshot> {
  const [
    partialActivations,
    auditFindings,
    failedJobs,
    failedEmails,
    webhookReviews,
    tierDrift,
    silentFailedJobs,
    orphanTasks,
  ] = await Promise.all([
    getPartialActivations(),
    getAuditFindings(),
    getFailedJobs(),
    getFailedEmails(),
    getWebhookReviews(),
    getTierDrift(),
    getSilentFailedJobs(),
    getOrphanTasks(),
  ])

  return {
    partialActivations,
    auditFindings,
    failedJobs,
    failedEmails,
    webhookReviews,
    tierDrift,
    silentFailedJobs,
    orphanTasks,
    totalCount:
      partialActivations.length +
      auditFindings.length +
      failedJobs.length +
      failedEmails.length +
      webhookReviews.length +
      tierDrift.length +
      silentFailedJobs.length +
      orphanTasks.length,
  }
}
