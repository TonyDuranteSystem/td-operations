/**
 * P3.8 — Per-record backend activity queries.
 *
 * Read-only surfaces for the "Backend" tab on account + contact detail
 * pages. Four sources, one unified shape:
 *   - action_log (direct account_id / contact_id filter)
 *   - job_queue (cron + background work)
 *   - webhook_events (payload JSONB text search)
 *   - session_checkpoints (summary / next_steps text search)
 *
 * Everything is returned ordered newest-first and capped. Callers render
 * read-only timelines; no mutations happen here.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface BackendActionRow {
  id: string
  actor: string | null
  action_type: string
  table_name: string
  summary: string
  details: unknown
  created_at: string
}

export interface BackendJobRow {
  id: string
  job_type: string
  status: string
  priority: number | null
  attempts: number | null
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface BackendWebhookRow {
  id: string
  source: string
  event_type: string
  external_id: string | null
  review_status: string | null
  created_at: string
}

export interface BackendCheckpointRow {
  id: string
  summary: string
  next_steps: string | null
  session_type: string | null
  created_at: string
}

export interface BackendActivity {
  actions: BackendActionRow[]
  jobs: BackendJobRow[]
  webhooks: BackendWebhookRow[]
  checkpoints: BackendCheckpointRow[]
}

const ACTION_LIMIT = 50
const JOB_LIMIT = 25
const WEBHOOK_LIMIT = 15
const CHECKPOINT_LIMIT = 15

export async function getAccountBackendActivity(accountId: string): Promise<BackendActivity> {
  const [actionsRes, jobsRes, webhooksRes, checkpointsRes] = await Promise.all([
    supabaseAdmin
      .from("action_log")
      .select("id, actor, action_type, table_name, summary, details, created_at")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(ACTION_LIMIT),
    supabaseAdmin
      .from("job_queue")
      .select("id, job_type, status, priority, attempts, error, created_at, started_at, completed_at")
      .or(`account_id.eq.${accountId},and(related_entity_type.eq.account,related_entity_id.eq.${accountId})`)
      .order("created_at", { ascending: false })
      .limit(JOB_LIMIT),
    supabaseAdmin
      .from("webhook_events")
      .select("id, source, event_type, external_id, review_status, created_at")
      .ilike("payload::text", `%${accountId}%`)
      .order("created_at", { ascending: false })
      .limit(WEBHOOK_LIMIT),
    supabaseAdmin
      .from("session_checkpoints")
      .select("id, summary, next_steps, session_type, created_at")
      .or(`summary.ilike.%${accountId}%,next_steps.ilike.%${accountId}%`)
      .order("created_at", { ascending: false })
      .limit(CHECKPOINT_LIMIT),
  ])

  return {
    actions: (actionsRes.data ?? []) as BackendActionRow[],
    jobs: (jobsRes.data ?? []) as BackendJobRow[],
    webhooks: (webhooksRes.data ?? []) as BackendWebhookRow[],
    checkpoints: (checkpointsRes.data ?? []) as BackendCheckpointRow[],
  }
}

export async function getContactBackendActivity(
  contactId: string,
  opts: { email?: string | null } = {},
): Promise<BackendActivity> {
  const tokens = [contactId]
  if (opts.email) tokens.push(opts.email)

  const ilikeClause = (column: string) =>
    tokens.map(t => `${column}.ilike.%${t}%`).join(",")

  const [actionsRes, jobsRes, webhooksRes, checkpointsRes] = await Promise.all([
    supabaseAdmin
      .from("action_log")
      .select("id, actor, action_type, table_name, summary, details, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(ACTION_LIMIT),
    supabaseAdmin
      .from("job_queue")
      .select("id, job_type, status, priority, attempts, error, created_at, started_at, completed_at")
      .eq("related_entity_type", "contact")
      .eq("related_entity_id", contactId)
      .order("created_at", { ascending: false })
      .limit(JOB_LIMIT),
    supabaseAdmin
      .from("webhook_events")
      .select("id, source, event_type, external_id, review_status, created_at")
      .or(ilikeClause("payload::text"))
      .order("created_at", { ascending: false })
      .limit(WEBHOOK_LIMIT),
    supabaseAdmin
      .from("session_checkpoints")
      .select("id, summary, next_steps, session_type, created_at")
      .or(tokens.flatMap(t => [`summary.ilike.%${t}%`, `next_steps.ilike.%${t}%`]).join(","))
      .order("created_at", { ascending: false })
      .limit(CHECKPOINT_LIMIT),
  ])

  return {
    actions: (actionsRes.data ?? []) as BackendActionRow[],
    jobs: (jobsRes.data ?? []) as BackendJobRow[],
    webhooks: (webhooksRes.data ?? []) as BackendWebhookRow[],
    checkpoints: (checkpointsRes.data ?? []) as BackendCheckpointRow[],
  }
}

/**
 * Summary counts for a record — useful for badging the Backend tab
 * without loading the full timeline.
 */
export interface BackendActivityCounts {
  actions: number
  jobs: number
  webhooks: number
  checkpoints: number
  total: number
}

export function summarizeActivity(activity: BackendActivity): BackendActivityCounts {
  const counts = {
    actions: activity.actions.length,
    jobs: activity.jobs.length,
    webhooks: activity.webhooks.length,
    checkpoints: activity.checkpoints.length,
  }
  return { ...counts, total: counts.actions + counts.jobs + counts.webhooks + counts.checkpoints }
}
