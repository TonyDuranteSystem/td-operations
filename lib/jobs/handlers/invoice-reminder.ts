/**
 * Job handler: invoice_reminder
 *
 * Sends ONE payment reminder via the shared sendInvoiceReminder(). Enqueued by
 * the dunning pass (lib/billing/dunning.ts) so a large batch is delivered
 * gradually by the background worker instead of inline within one capped run.
 *
 * payload: { paymentId: string, source: "auto" | "manual" }
 *
 * Outcome mapping:
 *   - sent            → completed (ok)
 *   - ok but not sent → completed/skipped (already sent recently, or the
 *     invoice was paid / hit the 2-reminder cap between enqueue and send)
 *   - permanent error (no email, bad status, not found) → ok:false (failed,
 *     surfaced in the Exception Center, NOT retried)
 *   - transient error (e.g. a Gmail hiccup) → throw, so the queue retries it
 *     up to max_attempts.
 */

import type { Job, JobResult } from "../queue"
import { sendInvoiceReminder } from "@/lib/billing/invoice-reminder"

const ts = () => new Date().toISOString()
const PERMANENT = /no contact email|cannot remind on invoice with status|invoice not found/i

export async function handleInvoiceReminder(job: Job): Promise<JobResult> {
  const paymentId = String((job.payload as { paymentId?: string }).paymentId ?? "")
  const source = (job.payload as { source?: string }).source === "manual" ? "manual" : "auto"

  if (!paymentId) {
    return { steps: [{ name: "validate", status: "error", detail: "missing paymentId", timestamp: ts() }], summary: "missing paymentId", ok: false }
  }

  const r = await sendInvoiceReminder(paymentId, { source })

  if (r.ok && r.sent) {
    return {
      steps: [{ name: "send", status: "ok", detail: `sent to ${r.recipient}`, timestamp: ts() }],
      summary: `Reminder #${r.reminderNumber ?? "?"} sent to ${r.recipient}`,
    }
  }

  if (r.ok) {
    // Not sent, but no error — invoice paid / capped / already reminded since enqueue.
    return {
      steps: [{ name: "send", status: "skipped", detail: r.alreadySent ? "already sent recently" : "no longer eligible", timestamp: ts() }],
      summary: "Skipped — no longer eligible at send time",
    }
  }

  const err = r.error ?? "send failed"
  if (PERMANENT.test(err)) {
    return { steps: [{ name: "send", status: "error", detail: err, timestamp: ts() }], summary: err, ok: false }
  }
  // Transient — let the queue retry (up to max_attempts).
  throw new Error(err)
}
