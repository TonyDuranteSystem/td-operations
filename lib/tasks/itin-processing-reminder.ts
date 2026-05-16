/**
 * Pure-logic helpers for the /api/cron/itin-processing-check cron.
 *
 * Extracted to a .ts module (no Next.js / no DB imports) so vitest can
 * test the eligibility rules without needing the route runtime.
 *
 * Rules:
 *   - A task is eligible for a reminder if it has been waiting in
 *     itin_irs_processing for at least 4 weeks (28 days) since the task
 *     was created.
 *   - Once eligible, send at most one reminder every 4 weeks. The handler
 *     stamps task_meta.last_irs_reminder_at on send; the cron uses that
 *     to debounce repeats.
 *   - Stop reminding after 16 weeks (over the IRS 7–11 week window plus
 *     a margin). Beyond that, surface as a separate operator-level
 *     escalation rather than continuing to nudge the client.
 */

const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000
const SIXTEEN_WEEKS_MS = 16 * 7 * 24 * 60 * 60 * 1000

export interface ReminderCheckTask {
  id: string
  created_at: string
  task_meta: Record<string, unknown> | null
}

export type ReminderDecision =
  | { send: true; weeks_since_start: number; previously_sent_at: string | null }
  | { send: false; reason: "too_recent" | "already_reminded_recently" | "max_window_exceeded" | "invalid_dates" }

function readLastReminderAt(taskMeta: Record<string, unknown> | null): string | null {
  if (!taskMeta) return null
  const v = taskMeta.last_irs_reminder_at
  return typeof v === "string" ? v : null
}

export function decideReminder(task: ReminderCheckTask, now: Date): ReminderDecision {
  const createdMs = Date.parse(task.created_at)
  if (Number.isNaN(createdMs)) return { send: false, reason: "invalid_dates" }
  const ageMs = now.getTime() - createdMs

  if (ageMs < FOUR_WEEKS_MS) {
    return { send: false, reason: "too_recent" }
  }
  if (ageMs > SIXTEEN_WEEKS_MS) {
    return { send: false, reason: "max_window_exceeded" }
  }

  const lastReminder = readLastReminderAt(task.task_meta)
  if (lastReminder) {
    const lastMs = Date.parse(lastReminder)
    if (!Number.isNaN(lastMs) && now.getTime() - lastMs < FOUR_WEEKS_MS) {
      return { send: false, reason: "already_reminded_recently" }
    }
  }

  const weeks = Math.floor(ageMs / (7 * 24 * 60 * 60 * 1000))
  return { send: true, weeks_since_start: weeks, previously_sent_at: lastReminder }
}

export function buildReminderMessage(args: {
  first_name: string
  language: "en" | "it"
  weeks_since_start: number
}): string {
  const { first_name: name, language, weeks_since_start } = args
  if (language === "it") {
    return `Ciao ${name}, un aggiornamento sulla tua richiesta ITIN: il pacchetto è stato inviato all'IRS ${weeks_since_start} settimane fa e siamo in attesa della loro risposta. L'IRS impiega tipicamente 7–11 settimane per processare le richieste ITIN. Ti contatteremo non appena riceveremo il numero. Grazie per la pazienza.`
  }
  return `Hi ${name}, an update on your ITIN application: your package was sent to the IRS ${weeks_since_start} weeks ago and we're waiting for their response. The IRS typically processes ITIN applications within 7–11 weeks. We'll reach out as soon as the number arrives. Thanks for your patience.`
}
