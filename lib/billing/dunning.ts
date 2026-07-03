/**
 * Dunning pass — shared by the daily cron AND the "Run reminders now" button.
 *
 * Two steps:
 *   1. markOverdueInvoices() — flip Sent/Partial → Overdue when past due
 *      (skips paused accounts). ALWAYS runs.
 *   2. enqueueDueReminders() — for each Overdue invoice that reached its
 *      per-account threshold (default 7d then 14d) and is under the 2-reminder
 *      cap, ENQUEUE an `invoice_reminder` job (deduped). The shared background
 *      worker (process-jobs, ~10/5min, low priority) actually sends them — so a
 *      large batch is delivered gradually with retries, no function timeout,
 *      and no email-reputation spike. `cap` bounds how many we enqueue per pass
 *      (a safety rail against a runaway), oldest-first.
 *
 * The automatic on/off lives in `app_settings` (key `dunning_autosend`,
 * value `{ enabled: boolean, cap: number }`) so it's controllable from the UI
 * — NOT a redeploy-only env var. `isAutoSendEnabled()` reads it (default OFF).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { syncInvoiceStatus } from "@/lib/portal/unified-invoice"
import { isAccountReminderPaused } from "@/lib/billing/reminder-snooze"
import { enqueueJobs } from "@/lib/jobs/queue"

/** Default per-pass enqueue bound (gentle backlog rollout; UI-configurable). */
export const DUNNING_RUN_CAP = 40

/** Job priority for reminder jobs — higher number = lower precedence than
 *  operational jobs (default 5), so a reminder burst never delays them. */
export const REMINDER_JOB_PRIORITY = 8

export const DUNNING_AUTOSEND_KEY = "dunning_autosend"

export interface DunningSummary {
  marked_overdue: number
  /** Reminder jobs enqueued this pass (the worker delivers them gradually). */
  reminders_queued: number
  /** Eligible invoices skipped because a reminder job is already queued. */
  skipped: number
  /** True if we hit the per-pass enqueue cap (more remain; run again). */
  capped: boolean
  considered: number
  auto_send: boolean
  errors: string[]
}

/**
 * Pure eligibility decision for one overdue invoice: send a reminder when it's
 * reached the 1st-reminder threshold (none sent) or the 2nd-reminder threshold
 * (one sent). Caps at 2 reminders total.
 */
export function shouldRemindNow(p: { daysOverdue: number; reminderCount: number; r1: number; r2: number }): boolean {
  if (p.reminderCount >= 2) return false
  if (p.daysOverdue >= p.r2 && p.reminderCount < 2) return true
  if (p.daysOverdue >= p.r1 && p.reminderCount < 1) return true
  return false
}

/** Max enqueue-per-pass allowed — clamps the configurable cap so a typo or a
 *  data bug can't queue an unbounded blast. Delivery is paced by the worker,
 *  so this can be generous. */
export const DUNNING_CAP_MAX = 1000

/** Clamp a user-entered per-run cap to a safe integer in [1, DUNNING_CAP_MAX].
 *  Invalid input falls back to the default DUNNING_RUN_CAP. */
export function clampCap(n: unknown): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 1) return DUNNING_RUN_CAP
  return Math.min(v, DUNNING_CAP_MAX)
}

/** Read the dunning settings (enabled + per-run cap) from app_settings. */
async function readDunningSettings(): Promise<{ enabled: boolean; cap: number }> {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", DUNNING_AUTOSEND_KEY)
    .single()
  const value = (data as { value?: { enabled?: boolean; cap?: number } } | null)?.value
  return {
    enabled: value?.enabled === true,
    cap: value?.cap == null ? DUNNING_RUN_CAP : clampCap(value.cap),
  }
}

/** Read the UI-controlled automatic-send flag from app_settings. Default OFF. */
export async function isAutoSendEnabled(): Promise<boolean> {
  return (await readDunningSettings()).enabled
}

/** Read the UI-controlled per-run send cap from app_settings. Default 40. */
export async function getDunningCap(): Promise<number> {
  return (await readDunningSettings()).cap
}

/** Step 1 — mark Sent/Partial invoices Overdue when past due (skips paused). */
async function markOverdueInvoices(errors: string[]): Promise<number> {
  const today = new Date().toISOString().split("T")[0]

  const { data: pausedAccounts } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .eq("dunning_pause", true)
  const pausedIds = (pausedAccounts ?? []).map((a) => a.id)

  let candidateQuery = supabaseAdmin
    .from("payments")
    .select("id, invoice_number, account_id")
    .in("invoice_status", ["Sent", "Partial"])
    .lt("due_date", today)
  if (pausedIds.length > 0) {
    candidateQuery = candidateQuery.not("account_id", "in", `(${pausedIds.join(",")})`)
  }

  const { data: candidates, error } = await candidateQuery
  if (error) {
    errors.push(`Query overdue candidates: ${error.message}`)
    return 0
  }

  let marked = 0
  for (const inv of candidates ?? []) {
    try {
      await syncInvoiceStatus("payment", inv.id, "Overdue")
      marked++
    } catch (err) {
      errors.push(`Mark overdue ${inv.invoice_number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return marked
}

/** Step 2 — enqueue reminder jobs for due invoices, bounded to `cap` per pass
 *  (oldest-first). The background worker sends them. Dedups against
 *  already-queued reminders in a single query, then bulk-enqueues. */
async function enqueueDueReminders(cap: number, errors: string[]): Promise<{ queued: number; skipped: number; considered: number; capped: boolean }> {
  const { data: accountConfigs } = await supabaseAdmin
    .from("accounts")
    .select("id, dunning_reminder_1_days, dunning_reminder_2_days, dunning_pause, dunning_pause_until")
  const cfg: Record<string, { r1: number; r2: number; paused: boolean }> = {}
  for (const ac of (accountConfigs ?? []) as unknown as Array<{
    id: string
    dunning_reminder_1_days: number | null
    dunning_reminder_2_days: number | null
    dunning_pause: boolean | null
    dunning_pause_until: string | null
  }>) {
    cfg[ac.id] = {
      r1: ac.dunning_reminder_1_days ?? 7,
      r2: ac.dunning_reminder_2_days ?? 14,
      // Boolean pause (indefinite) OR an active dated pause ("promised to pay
      // by X" — expires by itself). Only gates REMINDERS, never Overdue marking.
      paused: isAccountReminderPaused(ac),
    }
  }

  const { data: overdue } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, due_date, reminder_count, account_id")
    .eq("invoice_status", "Overdue")
    .order("due_date", { ascending: true })

  // 1) Filter to eligible invoices (up to cap), oldest-first.
  const eligible: Array<{ id: string; account_id: string | null }> = []
  let considered = 0
  let capped = false
  for (const inv of overdue ?? []) {
    if (eligible.length >= cap) { capped = true; break }
    const c = inv.account_id ? cfg[inv.account_id] : null
    if (c?.paused || !inv.due_date) continue
    const daysOverdue = Math.floor((Date.now() - new Date(inv.due_date + "T00:00:00").getTime()) / 86_400_000)
    if (!shouldRemindNow({ daysOverdue, reminderCount: inv.reminder_count ?? 0, r1: c?.r1 ?? 7, r2: c?.r2 ?? 14 })) continue
    considered++
    eligible.push({ id: inv.id, account_id: inv.account_id })
  }

  if (eligible.length === 0) return { queued: 0, skipped: 0, considered, capped }

  // 2) Dedup in ONE query — drop invoices that already have a pending/processing
  //    reminder job (a re-run or overlapping cron shouldn't double-queue).
  const { data: existing } = await supabaseAdmin
    .from("job_queue")
    .select("related_entity_id")
    .eq("job_type", "invoice_reminder")
    .in("status", ["pending", "processing"])
    .in("related_entity_id", eligible.map((e) => e.id))
  const alreadyQueued = new Set((existing ?? []).map((r) => (r as { related_entity_id: string }).related_entity_id))

  const toQueue = eligible.filter((e) => !alreadyQueued.has(e.id))
  const skipped = eligible.length - toQueue.length

  // 3) Bulk-enqueue (single insert + one worker trigger).
  try {
    await enqueueJobs(
      toQueue.map((e) => ({
        job_type: "invoice_reminder",
        payload: { paymentId: e.id, source: "auto" },
        priority: REMINDER_JOB_PRIORITY,
        account_id: e.account_id ?? undefined,
        related_entity_type: "payment",
        related_entity_id: e.id,
        created_by: "dunning",
      })),
    )
  } catch (err) {
    errors.push(`Enqueue reminders: ${err instanceof Error ? err.message : String(err)}`)
    return { queued: 0, skipped, considered, capped }
  }

  return { queued: toQueue.length, skipped, considered, capped }
}

/**
 * Run a full dunning pass. Always marks overdue. Enqueues reminder jobs only
 * when `autoSend` is true (the cron passes the app_settings flag; the "Run
 * now" button passes true). `cap` bounds enqueues per pass; the background
 * worker delivers them gradually.
 */
export async function runDunning(opts: { cap?: number; autoSend: boolean }): Promise<DunningSummary> {
  const cap = opts.cap ?? (await getDunningCap())
  const errors: string[] = []
  const marked_overdue = await markOverdueInvoices(errors)

  if (!opts.autoSend) {
    return { marked_overdue, reminders_queued: 0, skipped: 0, capped: false, considered: 0, auto_send: false, errors }
  }

  const { queued, skipped, considered, capped } = await enqueueDueReminders(cap, errors)
  return { marked_overdue, reminders_queued: queued, skipped, capped, considered, auto_send: true, errors }
}
