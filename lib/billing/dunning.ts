/**
 * Dunning pass — shared by the daily cron AND the "Run reminders now" button.
 *
 * Two steps:
 *   1. markOverdueInvoices() — flip Sent/Partial → Overdue when past due
 *      (skips paused accounts). ALWAYS runs.
 *   2. sendDueReminders() — for each Overdue invoice, send the reminder if it's
 *      reached its per-account threshold (default 7d then 14d) and is under the
 *      2-reminder cap. Throttled to `cap` sends per run (oldest-first) so a
 *      large backlog rolls out gently instead of blasting in one run.
 *
 * The automatic on/off lives in `app_settings` (key `dunning_autosend`,
 * value `{ enabled: boolean }`) so it's controllable from the UI — NOT a
 * redeploy-only env var. `isAutoSendEnabled()` reads it (default OFF).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { syncInvoiceStatus } from "@/lib/portal/unified-invoice"
import { sendInvoiceReminder } from "@/lib/billing/invoice-reminder"

/** Max reminder SENDS per dunning run (gentle backlog rollout). */
export const DUNNING_RUN_CAP = 40

export const DUNNING_AUTOSEND_KEY = "dunning_autosend"

export interface DunningSummary {
  marked_overdue: number
  reminders_sent: number
  skipped: number
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

/** Max sends allowed per run — clamps the configurable cap so a typo can't
 *  blast thousands or exceed the serverless function time budget. */
export const DUNNING_CAP_MAX = 200

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

/** Step 2 — send due reminders, throttled to `cap` sends (oldest-first). */
async function sendDueReminders(cap: number, errors: string[]): Promise<{ sent: number; skipped: number; considered: number; capped: boolean }> {
  const { data: accountConfigs } = await supabaseAdmin
    .from("accounts")
    .select("id, dunning_reminder_1_days, dunning_reminder_2_days, dunning_pause")
  const cfg: Record<string, { r1: number; r2: number; paused: boolean }> = {}
  for (const ac of accountConfigs ?? []) {
    cfg[ac.id] = {
      r1: ac.dunning_reminder_1_days ?? 7,
      r2: ac.dunning_reminder_2_days ?? 14,
      paused: ac.dunning_pause ?? false,
    }
  }

  const { data: overdue } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, due_date, reminder_count, account_id")
    .eq("invoice_status", "Overdue")
    .order("due_date", { ascending: true })

  let sent = 0
  let skipped = 0
  let considered = 0
  for (const inv of overdue ?? []) {
    if (sent >= cap) return { sent, skipped, considered, capped: true }

    const c = inv.account_id ? cfg[inv.account_id] : null
    if (c?.paused) continue
    if (!inv.due_date) continue

    const daysOverdue = Math.floor((Date.now() - new Date(inv.due_date + "T00:00:00").getTime()) / 86_400_000)
    const count = inv.reminder_count ?? 0
    if (!shouldRemindNow({ daysOverdue, reminderCount: count, r1: c?.r1 ?? 7, r2: c?.r2 ?? 14 })) continue

    considered++
    const r = await sendInvoiceReminder(inv.id, { source: "auto" })
    if (r.ok && r.sent) sent++
    else if (r.ok) skipped++
    else errors.push(`Remind ${inv.invoice_number}: ${r.error ?? "unknown error"}`)
  }
  return { sent, skipped, considered, capped: false }
}

/**
 * Run a full dunning pass. Always marks overdue. Sends reminders only when
 * `autoSend` is true (the cron passes the app_settings flag; the "Run now"
 * button passes true). `cap` throttles sends per run.
 */
export async function runDunning(opts: { cap?: number; autoSend: boolean }): Promise<DunningSummary> {
  const cap = opts.cap ?? (await getDunningCap())
  const errors: string[] = []
  const marked_overdue = await markOverdueInvoices(errors)

  if (!opts.autoSend) {
    return { marked_overdue, reminders_sent: 0, skipped: 0, capped: false, considered: 0, auto_send: false, errors }
  }

  const { sent, skipped, considered, capped } = await sendDueReminders(cap, errors)
  return { marked_overdue, reminders_sent: sent, skipped, capped, considered, auto_send: true, errors }
}
