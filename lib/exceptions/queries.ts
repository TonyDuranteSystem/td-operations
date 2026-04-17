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

export interface ExceptionsSnapshot {
  partialActivations: PartialActivationRow[]
  auditFindings: AuditFindingRow[]
  failedJobs: FailedJobRow[]
  failedEmails: FailedEmailRow[]
  webhookReviews: WebhookReviewRow[]
  totalCount: number
}

/**
 * One-call fetch for all sources. Pages awaiting this are already inside a
 * React Server Component — running the five queries in parallel beats doing
 * them sequentially on render.
 */
export async function getExceptionsSnapshot(): Promise<ExceptionsSnapshot> {
  const [partialActivations, auditFindings, failedJobs, failedEmails, webhookReviews] =
    await Promise.all([
      getPartialActivations(),
      getAuditFindings(),
      getFailedJobs(),
      getFailedEmails(),
      getWebhookReviews(),
    ])

  return {
    partialActivations,
    auditFindings,
    failedJobs,
    failedEmails,
    webhookReviews,
    totalCount:
      partialActivations.length +
      auditFindings.length +
      failedJobs.length +
      failedEmails.length +
      webhookReviews.length,
  }
}
