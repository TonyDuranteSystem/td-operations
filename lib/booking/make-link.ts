/**
 * Booking page — making a link, FREE (Stage 1b) or PAID (Stage 3). One function: check everything, then write one row.
 *
 *   1. the kind (a catalog row) must exist, be active, and have a rule (a kind with no rule is "needs setup" and is refused)
 *   2. the person is read (contact / lead / someone new); the emails the link will compare a booker with are SNAPSHOTTED now
 *   3. decideLinkPlan (the pure rules of Stage 1a) judges length, template and "first booking only"; anything it refuses is shown in plain words
 *   4. the Calendly call type for the plan is read from app_settings.booking_templates (never hard-coded); a missing one is refused with a plain sentence
 *   5. a standard 30-minute link needs nothing from Calendly (the redirect resolves the booking page at click time, so a renamed page keeps working);
 *      any other length asks Calendly for a one-time link of that length, and the address it returns is stored
 *   6. the row is written with a fresh random id (a clash on the id retries with a new one)
 * A PAID link also stores the price, how it will be recorded (decideLinkPlan's `payMode`) and a random pay code; it is always a one-time Calendly link. No referrer yet (Stage 2).
 */

import { APP_BASE_URL } from "@/lib/config"
import { decideLinkPlan, STANDARD_MINUTES, type LinkPlan, type QuestionsChoice } from "@/lib/booking/plan"
import { parseKindRule } from "@/lib/booking/kinds"
import { loadTemplates, templateFor, TEMPLATES_MISSING_TEXT } from "@/lib/booking/templates"
import { describePlan, type PreviewLine } from "@/lib/booking/preview"
import { loadPerson, type PersonFacts, type PersonRef } from "@/lib/booking/person"
import { newLinkId } from "@/lib/booking-links/id"
import { isMissingTable, isUniqueViolation } from "@/lib/booking-links/missing-table"
import { normalizeLeadLanguage } from "@/lib/booking-links/language"
import { CalendlyError, type CalendlyCtx } from "@/lib/calendly/api"
import { createShareLink } from "@/lib/calendly/api-write"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links is not in the generated database types until the production migration is applied
type Db = any

export interface MakeLinkInput {
  person: PersonRef
  kindSlug: string
  minutes: unknown
  firstBookingOnly?: boolean
  /** what the booker is asked; left out = the system decides (the old rule) */
  questions?: QuestionsChoice
  /** a PAID link (Stage 3): the price. Left out or null = a free link. The amount, currency and size checks are decideLinkPlan's. */
  payment?: { amount: unknown; currency: unknown; label?: unknown; confirmed?: boolean } | null
}

export interface KindRow {
  id: string
  slug: string
  display_name: string
  status: string
  metadata: unknown
}

export function linkUrl(publicId: string, baseUrl: string = APP_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}/r/b/${publicId}`
}

export async function loadKind(db: Db, slug: string): Promise<{ ok: true; kind: KindRow } | { ok: false; error: string }> {
  try {
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) return { ok: false, error: "Pick what kind of call this is." }
    const { data, error } = await db.from("catalog_entries").select("id, slug, display_name, status, metadata").eq("catalog_id", "booking_kinds").eq("slug", slug).maybeSingle()
    if (error) return { ok: false, error: "The kinds could not be read. Try again." }
    if (!data) return { ok: false, error: "That kind does not exist any more. Pick another." }
    if (data.status !== "active") return { ok: false, error: "That kind is retired. Restore it first, or pick another." }
    return { ok: true, kind: data as KindRow }
  } catch {
    return { ok: false, error: "The kinds could not be read. Try again." }
  }
}

export interface Judged {
  person: PersonFacts
  kind: KindRow
  plan: LinkPlan
  lines: PreviewLine[]
  /** a paid link above the size that needs a tick ("yes, this amount is right"): the maker must send `confirmed` before the link is made */
  needsConfirm: boolean
}

/** Everything up to (and including) the rules — no Calendly, no write. Used by the live preview AND by making the link, so they can never disagree. */
export async function judgeLink(db: Db, input: MakeLinkInput): Promise<{ ok: true; judged: Judged } | { ok: false; errors: string[] }> {
  const k = await loadKind(db, input.kindSlug)
  if ("error" in k) return { ok: false, errors: [k.error] }
  const rule = parseKindRule(k.kind.metadata)
  if ("reason" in rule) return { ok: false, errors: [`${k.kind.display_name}: ${rule.reason} Ask Claude to set it up.`] }
  const p = await loadPerson(db, input.person)
  if ("error" in p) return { ok: false, errors: [p.error] }
  const r = decideLinkPlan({
    person: { state: p.person.state, established: p.person.established },
    kind: { slug: k.kind.slug, label: k.kind.display_name, metadata: k.kind.metadata },
    minutes: input.minutes,
    firstBookingOnly: input.firstBookingOnly === true,
    questions: input.questions,
    payment: input.payment ?? null,
  })
  if ("errors" in r) return { ok: false, errors: r.errors }
  return {
    ok: true,
    judged: {
      person: p.person,
      kind: k.kind,
      plan: r.plan,
      lines: describePlan({ plan: r.plan, personState: p.person.state, personName: p.person.name, hasEmails: p.person.emails.length > 0 }),
      needsConfirm: r.needsConfirm,
    },
  }
}

export interface MadeLink {
  id: string
  publicId: string
  url: string
  /** for the "Email it" draft: the person's first email, and their language (so the draft is written in it) */
  email: string | null
  language: "Italian" | "English" | null
}

export interface MakeDeps {
  db: Db
  calendly: CalendlyCtx
  /** who is making it (an email), written on the row */
  createdBy: string
  baseUrl?: string
}

const INSERT_TRIES = 3

export const LARGE_AMOUNT_TEXT = "That is a large amount: tick the box to confirm it is right."
export const PAID_NOT_READY_TEXT = "Paid links are not ready on this database yet (the payment columns have not been added). Nothing was made. Tell Claude."

/** Makes a link: FREE, or PAID when `input.payment` is set (Stage 3). One function, so the preview and the made link can never disagree. */
export async function makeLink(deps: MakeDeps, input: MakeLinkInput): Promise<{ ok: true; link: MadeLink; lines: PreviewLine[] } | { ok: false; errors: string[]; needsConfirm?: boolean }> {
  const { db } = deps
  const j = await judgeLink(db, input)
  if ("errors" in j) return j
  const { person, kind, plan, lines } = j.judged
  if (j.judged.needsConfirm) return { ok: false, errors: [LARGE_AMOUNT_TEXT], needsConfirm: true }

  const templates = await loadTemplates(db)
  const tpl = templateFor(templates, plan.template)
  if (!tpl) return { ok: false, errors: [TEMPLATES_MISSING_TEXT] }

  // A paid call is always a one-time Calendly link, even at 30 minutes: the standard link can be booked again and again, and a payment must belong to ONE booking.
  const paid = plan.payment
  if (paid) {
    // The payment columns arrive with the Stage 3 migration. Check BEFORE asking Calendly for a link: on a database without them the save would fail afterwards and leave a
    // one-time Calendly link that nobody can use.
    try {
      const probe = await db.from("booking_links").select("pay_code").limit(1)
      if (probe.error) return { ok: false, errors: [(probe.error as { code?: unknown }).code === "42703" ? PAID_NOT_READY_TEXT : "The link could not be saved. Try again."] }
    } catch {
      return { ok: false, errors: ["The link could not be saved. Try again."] }
    }
  }
  let shareUrl: string | null = null
  if (plan.minutes !== STANDARD_MINUTES || paid) {
    try {
      shareUrl = (await createShareLink(deps.calendly, { eventTypeUri: tpl.eventTypeUri, minutes: plan.minutes })).url
    } catch (err) {
      return { ok: false, errors: [calendlyFailureText(err)] }
    }
  }

  const language = normalizeLeadLanguage(person.language)
  for (let attempt = 0; attempt < INSERT_TRIES; attempt++) {
    const publicId = newLinkId()
    try {
      const { data, error } = await db
        .from("booking_links")
        .insert({
          ...(paid ? { pay_amount_cents: paid.amountCents, pay_currency: paid.currency, pay_label: paid.label, pay_mode: paid.payMode, pay_code: newLinkId() } : {}),
          public_id: publicId,
          kind_label: kind.display_name,
          kind_entry_id: kind.id,
          rule_snapshot: plan.snapshot,
          contact_id: person.contactId,
          account_id: person.accountId,
          lead_id: person.leadId,
          person_name: person.name,
          person_language: language,
          person_emails: person.emails,
          template_slug: plan.template,
          duration_minutes: plan.minutes,
          share_url: shareUrl,
          once: plan.once,
          status: "open",
          created_by: deps.createdBy,
        })
        .select("id, public_id")
        .single()
      if (!error && data) return { ok: true, link: { id: data.id as string, publicId: data.public_id as string, url: linkUrl(publicId, deps.baseUrl), email: person.emails[0] ?? null, language }, lines }
      if (error && isUniqueViolation(error)) continue // a clash on the random id: draw another
      if (error && isMissingTable(error)) return { ok: false, errors: ["The Booking tables are not on this database yet."] }
      return { ok: false, errors: ["The link could not be saved. Try again."] }
    } catch {
      return { ok: false, errors: ["The link could not be saved. Try again."] }
    }
  }
  return { ok: false, errors: ["The link could not be saved. Try again."] }
}

/** The old name (free links only); kept so nothing that imported it breaks. A call WITHOUT `payment` makes exactly the free link it always made. */
export const makeFreeLink = makeLink

/** Plain words for a Calendly failure (R099): what to do, never the technical text. */
export function calendlyFailureText(err: unknown): string {
  if (!(err instanceof CalendlyError)) return "Calendly could not make the link. Try again in a moment."
  switch (err.kind) {
    case "not_configured": return "Calendly is not connected to this system yet, so a link with its own length cannot be made. A 30-minute link still works."
    case "auth":
    case "forbidden": return "Calendly did not allow the app to make this link. Nothing was made. Tell Claude."
    case "rate_limited": return "Calendly is busy. Wait a minute and try again."
    case "network":
    case "server": return "Calendly could not be reached. Try again in a moment."
    default: return "Calendly could not make the link. Nothing was made. Tell Claude."
  }
}
