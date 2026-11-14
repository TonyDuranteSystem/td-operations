/**
 * Booking page — decideLinkPlan: everything the link maker must decide BEFORE a link is made, as one pure function.
 * No database, no clock, no network. The caller (the maker routes, Stage 1b) gathers the facts and stores the returned plan on the link row.
 *
 * What it decides
 *   - the rule of the chosen kind (from the catalog row; a kind with no rule = "needs setup" = refused)
 *   - what will happen to this person's booking (`recorder`: attach under the contact | lead as today | nothing)
 *   - length: any whole number of minutes 1-720; exactly 30 = the standard reusable link, anything else (and every paid link, and every link with a referrer) = a one-time link
 *   - which Calendly template: the plain Zoom one, or the one that asks sales questions (only for a NEW person, on a FREE call, whose kind asks for it and makes a lead)
 *   - money (paid links): the amount goes through the SAME parser as the CRM payment-link maker (6 digits, at most 50,000, a tick above 2,000), at least 0.50, USD or EUR only,
 *     and `payMode` says how the payment will be booked (new person or lead = credit; an established client = revenue only; unknown = revenue only)
 *   - the referrer: only for a NEW person whose booking makes a lead, and only an eligible client with a code (never a partner)
 */

import { parseKindRule, buildRuleSnapshot, type KindRule, type RuleSnapshot } from "@/lib/booking/kinds"
import { parseAmountCents, CONFIRM_ABOVE } from "@/lib/incoming-payments/payment-link"

export const STANDARD_MINUTES = 30
export const MIN_MINUTES = 1
export const MAX_MINUTES = 720
/** Stripe's smallest card charge. */
export const MIN_PAID_CENTS = 50

export type PersonState = "new" | "lead" | "contact"
export type Recorder = "attach" | "lead" | "none"
export type PayMode = "credit" | "revenue_only"
export type TemplateRole = "sales" | "plain"

export interface LinkPlanInput {
  person: {
    state: PersonState
    /** For a contact: is this an established client (alias-aware check done by the caller)? undefined = could not tell. */
    established?: boolean
  }
  kind: { slug: string; label: string; metadata: unknown }
  minutes: unknown
  payment?: { amount: unknown; currency: unknown; label?: unknown; confirmed?: boolean } | null
  referrer?: { eligible: boolean; hasCode: boolean; contactId?: string | null; code?: string | null } | null
}

export interface LinkPlan {
  rule: KindRule
  snapshot: RuleSnapshot
  recorder: Recorder
  minutes: number
  /** true = a one-time link (one booking closes it); false = the standard reusable 30-minute link */
  once: boolean
  template: TemplateRole
  payment: { amountCents: number; currency: "USD" | "EUR"; label: string | null; payMode: PayMode } | null
  referrer: { contactId: string | null; code: string } | null
}

export type LinkPlanResult = { ok: true; plan: LinkPlan; needsConfirm: boolean } | { ok: false; errors: string[] }

const DEFAULT_PAID_LABEL_MAX = 80

/** Whole minutes only: 45, "45" — never 45.5, "45 min", "", NaN, negative. */
export function parseMinutes(raw: unknown): number | null {
  const s = typeof raw === "number" ? (Number.isInteger(raw) ? String(raw) : "") : typeof raw === "string" ? raw.trim() : ""
  if (!/^\d{1,3}$/.test(s)) return null
  const n = Number(s)
  return n >= MIN_MINUTES && n <= MAX_MINUTES ? n : null
}

/** What this person's booking will do, from the kind's rule. A person who is only a LEAD: today's behaviour (the lead is updated) unless the kind saves nothing. */
export function recorderFor(rule: KindRule, state: PersonState): Recorder {
  if (state === "new") return rule.new_person
  if (state === "lead") return rule.existing_person === "none" ? "none" : "lead"
  return rule.existing_person
}

/** How a paid call is booked: a prospect (new person, lead, or a contact who is not established) gets today's invoice + credit; an established client (or unknown) revenue only. */
export function payModeFor(person: LinkPlanInput["person"]): PayMode {
  if (person.state === "new" || person.state === "lead") return "credit"
  return person.established === false ? "credit" : "revenue_only"
}

export function decideLinkPlan(input: LinkPlanInput): LinkPlanResult {
  const errors: string[] = []

  const parsedKind = parseKindRule(input.kind.metadata)
  if ("reason" in parsedKind) errors.push(parsedKind.reason)

  const minutes = parseMinutes(input.minutes)
  if (minutes === null) errors.push(`Write the length as a whole number of minutes, from ${MIN_MINUTES} to ${MAX_MINUTES}.`)

  let payment: LinkPlan["payment"] = null
  let needsConfirm = false
  if (input.payment) {
    const cents = parseAmountCents(input.payment.amount)
    const currency = typeof input.payment.currency === "string" ? input.payment.currency.trim().toUpperCase() : ""
    if (cents === null) errors.push("Write the amount as a plain number, for example 397 or 397.50 (more than 0, at most 50,000).")
    else if (cents < MIN_PAID_CENTS) errors.push("The smallest amount that can be charged is 0.50.")
    if (currency !== "USD" && currency !== "EUR") errors.push("Pick USD or EUR.")
    const rawLabel = input.payment.label
    const label = typeof rawLabel === "string" ? rawLabel.replace(/\s+/g, " ").trim() : ""
    if (label.length > DEFAULT_PAID_LABEL_MAX) errors.push(`The payment description can be at most ${DEFAULT_PAID_LABEL_MAX} characters.`)
    if (cents !== null && cents >= MIN_PAID_CENTS && (currency === "USD" || currency === "EUR") && label.length <= DEFAULT_PAID_LABEL_MAX) {
      payment = { amountCents: cents, currency, label: label || null, payMode: payModeFor(input.person) }
      needsConfirm = cents / 100 > CONFIRM_ABOVE && input.payment.confirmed !== true
    }
  }

  if (errors.length || !parsedKind.ok || minutes === null) return { ok: false, errors }

  const rule = parsedKind.rule
  const recorder = recorderFor(rule, input.person.state)

  // A paid call books money; a kind that saves nothing would leave a payment with no person to put it on.
  if (payment && recorder === "none") errors.push("A paid call needs a kind that saves the call (Lead, Client or Partner) — a kind that saves nothing cannot take a payment.")

  let referrer: LinkPlan["referrer"] = null
  if (input.referrer) {
    if (input.person.state !== "new") errors.push("A referrer can only be set for someone who is new to us.")
    else if (recorder !== "lead") errors.push("A referrer can only be set when the booking makes a lead.")
    else if (!input.referrer.eligible) errors.push("That person cannot be a referrer (only clients with a referral link can).")
    else if (!input.referrer.hasCode || !input.referrer.code) errors.push("That client has no referral code yet.")
    else referrer = { contactId: input.referrer.contactId ?? null, code: input.referrer.code }
  }
  if (errors.length) return { ok: false, errors }

  // A referrer earns a credit for whoever claims the link, so the link must close on its first booking (never the reusable standard link, even at 30 minutes).
  const once = minutes !== STANDARD_MINUTES || payment !== null || referrer !== null
  const template: TemplateRole = input.person.state === "new" && payment === null && rule.sales_template && recorder === "lead" ? "sales" : "plain"

  return {
    ok: true,
    needsConfirm,
    plan: { rule, snapshot: buildRuleSnapshot({ slug: input.kind.slug, label: input.kind.label }, rule), recorder, minutes, once, template, payment, referrer },
  }
}
