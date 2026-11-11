/**
 * "Invoices to raise" — which later parts of a payment plan need a person to raise an invoice NOW, and which are only coming up
 * (dev job ae3c19db; Antonio, 2026-11-11: "nothing automatic — when it is time, the Calendar shows an invoice to raise, blinking red").
 *
 * PURE: given a part, where it stands, today's date and the offer's jobs, say whether it is DUE and why. The loader (load.ts) feeds it;
 * nothing here reads or writes anything. This file never raises, sends or schedules — it only answers "is it time?".
 *
 * WHEN A PART IS DUE
 *  - on a DATE: the day arrives (today >= the date). It stays due, and says how many days late, until it is raised.
 *  - when a STEP is reached: the offer's job for that service has reached the step (its own step number is the target's or later, or the
 *    job is completed). A step that cannot be found is NOT due — it is flagged, never guessed.
 *  - "when I say so" (manual): never due by itself; it is listed under "Coming up" with its reason, and staff may raise it any time.
 *  - a part with a Draft invoice (raised, not sent): due — the client has not been told, so a person still has to send it.
 * A part that already has a live invoice (sent, or paid) is not listed at all. Part 1 (signing) is never listed.
 */

import type { PartStatus } from "@/lib/offers/payment-plan-state"
import { clientFacingPartLabel } from "@/lib/offers/payment-plan"

/** The job fields the rule reads. */
export interface OfferJob {
  service_type: string | null
  stage_order: number | null
  status: string | null
  source_offer_token: string | null
}

/** Step numbers by service and step name, lower-cased: "company formation|ein received" → 8. */
export type StepOrders = Map<string, number>

export const stepKey = (serviceType: string, stage: string): string => `${serviceType.trim().toLowerCase()}|${stage.trim().toLowerCase()}`

export type PartDueReason =
  | { kind: "date"; date: string; daysLate: number }
  | { kind: "step"; serviceType: string; stage: string }
  | { kind: "draft"; invoiceNumber: string | null }

export interface PartClassification {
  /** True = a person should act now (the row blinks red). False = coming up. */
  due: boolean
  /** Why it is due (null when it is only coming up). */
  reason: PartDueReason | null
  /** Plain words for staff: "Due 1 Dec 2026 — 3 days late", "EIN Received reached", "Waiting: after the EIN arrives". */
  text: string
  /** A step trigger whose step is not in the service's step list any more — shown, never silently dropped. */
  stepNotFound: boolean
}

const DAY = 86_400_000
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY

/** "2026-12-01" → "1 Dec 2026" (UTC, like every other date in the plan's wording). */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** Has the offer's job for this service reached the step? Cancelled jobs never count. */
export function stepReached(p: { jobs: OfferJob[]; offerToken: string; serviceType: string; stage: string; stepOrders: StepOrders }): { reached: boolean; found: boolean } {
  const target = p.stepOrders.get(stepKey(p.serviceType, p.stage))
  if (typeof target !== "number") return { reached: false, found: false }
  const mine = p.jobs.filter(
    (j) =>
      j.source_offer_token === p.offerToken &&
      (j.service_type ?? "").trim().toLowerCase() === p.serviceType.trim().toLowerCase() &&
      j.status !== "cancelled",
  )
  const reached = mine.some((j) => j.status === "completed" || (typeof j.stage_order === "number" && j.stage_order >= target))
  return { reached, found: true }
}

export function classifyPlanPart(p: { status: PartStatus; todayIso: string; offerToken: string; jobs: OfferJob[]; stepOrders: StepOrders; totalParts: number }): PartClassification | null {
  const { part } = p.status
  if (part.trigger.kind === "signing") return null
  // A live invoice that is sent / awaiting / part-paid / paid: nothing left to raise or send.
  if (p.status.invoice && p.status.state !== "raised_unsent") return null

  // Raised but not sent: the client was never told.
  if (p.status.invoice && p.status.state === "raised_unsent") {
    const no = p.status.invoice.invoice_number
    return { due: true, reason: { kind: "draft", invoiceNumber: no }, text: `Invoice ${no ?? ""} is a draft — the client has not been sent it`.replace("  ", " "), stepNotFound: false }
  }

  const t = part.trigger
  if (t.kind === "date" && t.date) {
    const late = Math.floor(dayNumber(p.todayIso) - dayNumber(t.date))
    if (late >= 0) {
      return { due: true, reason: { kind: "date", date: t.date, daysLate: late }, text: late === 0 ? `Due today (${shortDate(t.date)})` : `Due ${shortDate(t.date)} — ${late} day${late === 1 ? "" : "s"} late`, stepNotFound: false }
    }
    return { due: false, reason: null, text: `Due ${shortDate(t.date)}`, stepNotFound: false }
  }

  if (t.kind === "step" && t.service_type && t.stage) {
    const r = stepReached({ jobs: p.jobs, offerToken: p.offerToken, serviceType: t.service_type, stage: t.stage, stepOrders: p.stepOrders })
    if (r.reached) return { due: true, reason: { kind: "step", serviceType: t.service_type, stage: t.stage }, text: `${t.service_type}: "${t.stage}" reached`, stepNotFound: false }
    if (!r.found) return { due: false, reason: null, text: `Waiting for "${t.stage}" of ${t.service_type} — that step is not in the step list any more, check it`, stepNotFound: true }
    return { due: false, reason: null, text: `Waiting for "${t.stage}" of ${t.service_type}`, stepNotFound: false }
  }

  // "When I say so" (or anything unrecognised): never due by itself.
  const wording = clientFacingPartLabel(part, p.totalParts).replace(/^Part \d+ of \d+(, due | — due once complete: )?/, "")
  return { due: false, reason: null, text: `Waiting: ${wording || "when you say so"}`, stepNotFound: false }
}
