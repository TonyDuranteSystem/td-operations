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
  /** Overdue invoices whose due date moved to the future — flipped back to Sent/Partial. */
  unmarked_future_dated: number
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
 * Invoices with an incoming bank payment WAITING FOR A HUMAN TO CONFIRM IT — pure filter.
 *
 * ⛔ WHY CHASING THESE IS WRONG (2026-07-29, Antonio's decision when this fix was approved).
 * The ambiguity guard deliberately parks a transaction for review when the system cannot tell
 * which client's invoice it settles. And un-matching now restores an invoice to its true state
 * (Sent / Overdue) instead of hiding it as a Draft, which is honest but re-arms this pass. Put
 * together, an invoice can be genuinely PAID — the money sitting in the bank, pinned to that
 * invoice, waiting for a click — while this pass emails the client "Payment Overdue". The old
 * behaviour concealed it by accident; suppressing it is deliberate.
 *
 * It is a PAUSE, not a cancellation: `reminder_count` is untouched, so once the review is
 * resolved (confirmed, or rejected as not-for-this-invoice) chasing resumes exactly where it
 * left off.
 */
export function suppressWhilePaymentAwaitsReview(
  invoiceIds: string[],
  pinnedForReview: Array<{ matched_payment_id: string | null }>,
): { keep: string[]; suppressed: string[] } {
  const pinned = new Set(
    pinnedForReview.map((f) => f.matched_payment_id).filter((id): id is string => !!id),
  )
  const keep: string[] = []
  const suppressed: string[] = []
  for (const id of invoiceIds) (pinned.has(id) ? suppressed : keep).push(id)
  return { keep, suppressed }
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

/**
 * How many automatic chase emails an invoice would receive if it were live
 * RIGHT NOW, given the current settings. Pure — same rule as the real pass, so
 * a caller can WARN before creating the condition rather than discover it from
 * the client's inbox.
 *
 * Built for the reactivate flow: bringing back a long-overdue invoice with a
 * zero reminder count silently satisfies BOTH thresholds at once, so the next
 * two nightly passes fire back-to-back. That nearly happened to VictoriamRoas
 * LLC on 2026-07-10 (39 days past due, 0 reminders → 2 emails).
 */
export function projectedReminderCount(p: {
  autoSendEnabled: boolean
  accountPaused: boolean
  invoiceStatus: string
  daysOverdue: number
  reminderCount: number
  r1: number
  r2: number
}): number {
  if (!p.autoSendEnabled || p.accountPaused) return 0
  if (p.invoiceStatus !== "Overdue") return 0

  let reminderCount = p.reminderCount
  let sends = 0
  // shouldRemindNow caps at 2 reminders, so this always terminates.
  while (shouldRemindNow({ daysOverdue: p.daysOverdue, reminderCount, r1: p.r1, r2: p.r2 })) {
    sends++
    reminderCount++
  }
  return sends
}

/** Whole days between an ISO `YYYY-MM-DD` due date and an ISO `today`. Negative
 *  when the invoice is not yet due. Pure — `today` is passed, never read. */
export function daysPastDue(dueDate: string, today: string): number {
  const due = new Date(dueDate + "T00:00:00Z").getTime()
  const now = new Date(today + "T00:00:00Z").getTime()
  return Math.floor((now - due) / 86_400_000)
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

/**
 * Step 1b — the REVERSE of step 1, which never existed: un-mark Overdue invoices whose due
 * date has been moved into the future (a renegotiated payment date — Luca's Shoppyverse case,
 * 2026-07-28: due date pushed to September, label stuck on Overdue forever).
 *
 * Back to Partial when money has already been applied, else back to Sent — via the same
 * status-only writer step 1 uses, so both status columns and the client-expense mirror stay
 * in sync. `reminder_count` resets: a renegotiated due date starts a NEW reminder cycle, so
 * if the new date also passes unpaid, the client is reminded again rather than silently
 * skipped because the old cycle already used its two reminders.
 *
 * `>=` today (not `>`): an invoice due TODAY is not yet overdue — step 1 uses strictly-before
 * for marking, and the two must partition cleanly or a due-today invoice would flap.
 */
async function unmarkFutureDatedInvoices(errors: string[]): Promise<number> {
  const today = new Date().toISOString().split("T")[0]

  const { data: candidates, error } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, amount_paid")
    .eq("invoice_status", "Overdue")
    .gte("due_date", today)

  if (error) {
    errors.push(`Query future-dated overdue: ${error.message}`)
    return 0
  }

  let unmarked = 0
  for (const inv of candidates ?? []) {
    try {
      const backTo = Number(inv.amount_paid ?? 0) > 0 ? "Partial" : "Sent"
      await syncInvoiceStatus("payment", inv.id, backTo)
      // eslint-disable-next-line no-restricted-syntax -- reminder pacing reset, same table the dunning pass owns
      await supabaseAdmin.from("payments").update({ reminder_count: 0 }).eq("id", inv.id)
      unmarked++
    } catch (err) {
      errors.push(`Un-mark ${inv.invoice_number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return unmarked
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

  // Never chase a client whose money is already in the bank waiting for a human to confirm it.
  const { data: pinnedFeeds } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("matched_payment_id")
    .eq("status", "needs_review")
    .not("matched_payment_id", "is", null)
  const { suppressed } = suppressWhilePaymentAwaitsReview(
    eligible.map((e) => e.id),
    (pinnedFeeds ?? []) as Array<{ matched_payment_id: string | null }>,
  )
  if (suppressed.length > 0) {
    const held = new Set(suppressed)
    for (let i = eligible.length - 1; i >= 0; i--) {
      if (held.has(eligible[i].id)) eligible.splice(i, 1)
    }
    console.warn(
      `[dunning] Holding ${suppressed.length} reminder(s): an incoming bank payment is pinned to these invoices and awaiting review.`,
    )
    if (eligible.length === 0) return { queued: 0, skipped: 0, considered, capped }
  }

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
  // The reverse pass runs BEFORE reminders are enqueued, so an invoice whose due date was
  // renegotiated this morning cannot be considered for a reminder in the same run.
  const unmarked_future_dated = await unmarkFutureDatedInvoices(errors)

  if (!opts.autoSend) {
    return { marked_overdue, unmarked_future_dated, reminders_queued: 0, skipped: 0, capped: false, considered: 0, auto_send: false, errors }
  }

  const { queued, skipped, considered, capped } = await enqueueDueReminders(cap, errors)
  return { marked_overdue, unmarked_future_dated, reminders_queued: queued, skipped, capped, considered, auto_send: true, errors }
}
