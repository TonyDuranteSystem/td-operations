/**
 * Booking page — "Calls to check": the cards the Calendly webhook raised (table call_checks) for Antonio to look at, and his answers.
 * Stage 1b shows three kinds: mismatch (someone else booked a link made for a person), unknown_id (a booking came through a link we could not use) and
 * effect_failed (a booking could not be filed the way its link said). The paid-call card is Stage 3 and has no writer yet, so it is never listed here.
 *
 * Every function takes the database client as an argument and never throws. A failed read is reported as a failure — the Calendar tab must never show
 * "nothing needs you" because a read broke.
 *
 * Answering is claim-first: the card goes open -> answering in ONE conditional update (two clicks cannot both act), the action runs, and a failure puts the card back
 * to open with the reason. Every step of "Same person" is safe to repeat, so a retry after a half-finished answer finishes the job.
 */

import { isMissingTable } from "@/lib/booking-links/missing-table"
import { recordContactBooking } from "@/lib/leads/contact-calls"
import { claimLink, markEffectsDone } from "@/lib/booking-links/store"
import { contactEmailSet, escapeLike } from "@/lib/operations/contact-email-aliases"
import { addContactAliases } from "@/lib/operations/contact-aliases"
import { updateLeadColumnGuarded, isGuardedFailure, type LeadDb } from "@/lib/leads/guarded-update"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- call_checks / booking_links: untyped until the production migration is applied
type Db = any

export const SHOWN_KINDS = ["mismatch", "unknown_id", "effect_failed"] as const
export type ShownKind = (typeof SHOWN_KINDS)[number]

/** The answers a card accepts, per kind. Anything else is refused. */
export const ANSWERS_BY_KIND: Record<ShownKind, readonly string[]> = {
  mismatch: ["same_person", "different_person", "dismiss"],
  unknown_id: ["dismiss"],
  effect_failed: ["dismiss"],
}

/** a card left "answering" this long ago is shown again (an answer that crashed half way) */
const STALE_ANSWERING_MS = 5 * 60 * 1000

export interface CheckRow {
  id: string
  kind: string
  dedupe_key: string
  status: string
  booking_link_id: string | null
  lead_id: string | null
  contact_id: string | null
  calendly_event_uri: string | null
  payload: Record<string, unknown> | null
  created_at: string
  updated_at: string | null
}

interface LinkFacts {
  id: string
  contact_id: string | null
  account_id: string | null
  person_name: string | null
  person_emails: string[] | null
  kind_label: string
  status: string
  once: boolean
  revoked_at: string | null
}

export interface CardAnswer {
  key: string
  label: string
  primary: boolean
}
export interface CardDto {
  id: string
  kind: ShownKind
  question: string
  why: string
  /** an extra plain line (for example: why "Same person" is not offered) */
  note: string | null
  answers: CardAnswer[]
  madeAt: string
  /** when the booked call starts, if known */
  callAt: string | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`)

function bookerText(payload: Record<string, unknown>): string {
  const name = str(payload.booker_name)
  const email = str(payload.booker_email)
  if (name && email) return `${name} (${email})`
  return name ?? email ?? "someone"
}

const REASON_TEXT: Record<string, { question: string; why: string }> = {
  not_found: { question: "A booking came through a link code we do not know.", why: "The address may have been changed by hand, or the link was removed. The booking was saved as usual." },
  used: { question: "A booking came through a link that had already been used.", why: "A one-time link takes the first booking only. This booking was saved as usual, as a normal lead." },
  revoked: { question: "A booking came through a link you had stopped.", why: "The booking was saved as usual, as a normal lead." },
  expired: { question: "A booking came through a link that had expired.", why: "The booking was saved as usual, as a normal lead." },
  booking_already_linked: { question: "A booking was already attached to another link.", why: "It was saved as usual. Nothing was lost." },
}

/** The plain words of a card. Pure: takes the row and what we know about its link. */
export function describeCheck(row: CheckRow, link: Pick<LinkFacts, "contact_id" | "person_name" | "person_emails" | "kind_label"> | null, callAt: string | null): CardDto | null {
  if (!(SHOWN_KINDS as readonly string[]).includes(row.kind)) return null
  const kind = row.kind as ShownKind
  const p = row.payload ?? {}
  const kindLabel = str(p.kind_label) ?? link?.kind_label ?? ""
  const forWho = str(p.person_name) ?? link?.person_name ?? (link?.person_emails?.[0] ?? null)
  const base = { id: row.id, kind, madeAt: row.created_at, callAt }

  if (kind === "mismatch") {
    const who = forWho ?? "a person"
    const linkText = kindLabel ? `${possessive(who)} ${kindLabel.toLowerCase()} link` : `a link made for ${who}`
    const hasContact = !!(link?.contact_id ?? row.contact_id)
    const first = who.split(" ")[0]
    const answers: CardAnswer[] = []
    if (hasContact) answers.push({ key: "same_person", label: "Same person: link this email", primary: true })
    answers.push({ key: "different_person", label: "Different person", primary: !hasContact })
    answers.push({ key: "dismiss", label: "Dismiss", primary: false })
    return {
      ...base,
      question: `A different person booked ${linkText}. Is it still ${possessive(first)} call?`,
      why: `The link was made for ${who}. The booking came from ${bookerText(p)}. It was saved as a normal lead, nothing was dropped.`,
      note: hasContact ? null : "This link was made for a lead, and a lead keeps only one email, so this email cannot be linked here. You can still say it is a different person, or dismiss it.",
      answers,
    }
  }
  if (kind === "unknown_id") {
    const r = REASON_TEXT[str(p.reason) ?? ""] ?? REASON_TEXT.not_found
    return { ...base, question: r.question, why: `${r.why} It came from ${bookerText(p)}.`, note: forWho ? `The link had been made for ${forWho}${kindLabel ? ` (${kindLabel})` : ""}.` : null, answers: [{ key: "dismiss", label: "Dismiss", primary: true }] }
  }
  return {
    ...base,
    question: `A booking from ${bookerText(p)} could not be filed the way its link said.`,
    why: str(p.reason) ?? "Something went wrong while filing it.",
    note: "The booking itself was saved as usual, as a normal lead. Nothing was dropped.",
    answers: [{ key: "dismiss", label: "Dismiss", primary: true }],
  }
}

export type LoadChecks = { ok: true; cards: CardDto[]; count: number } | { ok: false; error: string }

export async function loadOpenChecks(db: Db, now: Date): Promise<LoadChecks> {
  try {
    const { data, error } = await db.from("call_checks").select("id, kind, dedupe_key, status, booking_link_id, lead_id, contact_id, calendly_event_uri, payload, created_at, updated_at").in("status", ["open", "answering"]).order("created_at", { ascending: false }).limit(200)
    if (error) return isMissingTable(error) ? { ok: true, cards: [], count: 0 } : { ok: false, error: "The calls to check could not be read." }
    const rows = ((data ?? []) as CheckRow[]).filter((r) => (SHOWN_KINDS as readonly string[]).includes(r.kind) && (r.status === "open" || (r.updated_at ? now.getTime() - new Date(r.updated_at).getTime() > STALE_ANSWERING_MS : true)))

    const linkIds = Array.from(new Set(rows.map((r) => r.booking_link_id).filter((x): x is string => !!x)))
    const links = new Map<string, LinkFacts>()
    if (linkIds.length) {
      const { data: ls, error: lerr } = await db.from("booking_links").select("id, contact_id, account_id, person_name, person_emails, kind_label, status, once, revoked_at").in("id", linkIds)
      if (!lerr) for (const l of (ls ?? []) as LinkFacts[]) links.set(l.id, l)
    }
    // when each call starts: the stray lead's call row carries it (read tolerant: a failed read just leaves the time out)
    const uris = Array.from(new Set(rows.map((r) => r.calendly_event_uri).filter((x): x is string => !!x)))
    const starts = new Map<string, string>()
    if (uris.length) {
      const { data: calls, error: cerr } = await db.from("lead_calls").select("calendly_event_uri, scheduled_start").in("calendly_event_uri", uris)
      if (!cerr) for (const c of (calls ?? []) as Array<{ calendly_event_uri: string | null; scheduled_start: string | null }>) if (c.calendly_event_uri && c.scheduled_start) starts.set(c.calendly_event_uri, c.scheduled_start)
    }
    const cards: CardDto[] = []
    for (const r of rows) {
      const card = describeCheck(r, r.booking_link_id ? links.get(r.booking_link_id) ?? null : null, r.calendly_event_uri ? starts.get(r.calendly_event_uri) ?? null : null)
      if (card) cards.push(card)
    }
    return { ok: true, cards, count: cards.length }
  } catch {
    return { ok: false, error: "The calls to check could not be read." }
  }
}

// ─── answering ───────────────────────────────────────────────────────────────

export type AnswerResult = { ok: true; message: string } | { ok: false; status: number; error: string }

export interface AnswerDeps {
  db: Db
  now?: Date
  /** who answers (an email), written on the card */
  by: string
  /** injectable for tests; defaults to the CRM's own helper that adds an alternate email to a contact */
  addAlias?: (contactId: string, altEmail: string) => Promise<{ ok: boolean; error?: string }>
}

const defaultAddAlias = (contactId: string, altEmail: string) => addContactAliases(contactId, { altEmail, phone: null })

async function revertToOpen(db: Db, id: string, now: Date): Promise<void> {
  try {
    await db.from("call_checks").update({ status: "open", updated_at: now.toISOString() }).eq("id", id).eq("status", "answering")
  } catch {
    /* the stale-answering rule shows the card again after a few minutes */
  }
}

export async function answerCheck(deps: AnswerDeps, id: string, answer: unknown): Promise<AnswerResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { ok: false, status: 404, error: "That card could not be found." }
  let row: CheckRow | null
  try {
    const { data, error } = await db.from("call_checks").select("id, kind, dedupe_key, status, booking_link_id, lead_id, contact_id, calendly_event_uri, payload, created_at, updated_at").eq("id", id).maybeSingle()
    if (error) return { ok: false, status: 500, error: "The card could not be read. Try again." }
    row = (data as CheckRow | null) ?? null
  } catch {
    return { ok: false, status: 500, error: "The card could not be read. Try again." }
  }
  if (!row) return { ok: false, status: 404, error: "That card could not be found." }
  if (!(SHOWN_KINDS as readonly string[]).includes(row.kind)) return { ok: false, status: 400, error: "That kind of card cannot be answered here." }
  const allowed = ANSWERS_BY_KIND[row.kind as ShownKind]
  if (typeof answer !== "string" || !allowed.includes(answer)) return { ok: false, status: 400, error: "That answer does not fit this card." }
  if (row.status === "answered") return { ok: true, message: "This card was already answered." }

  // claim first: only one answer can move the card from open to answering
  let claimed: boolean
  try {
    const stale = row.status === "answering" && row.updated_at && now.getTime() - new Date(row.updated_at).getTime() > STALE_ANSWERING_MS
    const q = db.from("call_checks").update({ status: "answering", updated_at: now.toISOString() }).eq("id", id).eq("status", stale ? "answering" : "open")
    const { data, error } = await q.select("id")
    if (error) return { ok: false, status: 500, error: "The card could not be answered. Try again." }
    claimed = Array.isArray(data) && data.length > 0
  } catch {
    return { ok: false, status: 500, error: "The card could not be answered. Try again." }
  }
  if (!claimed) return { ok: false, status: 409, error: "Someone else is answering this card, or it was just answered. Reload the page." }

  let message = "Done."
  try {
    if (answer === "same_person") {
      const r = await linkSamePerson(deps, row, now)
      if (!r.ok) {
        await revertToOpen(db, id, now)
        return r
      }
      message = r.message
    } else if (answer === "different_person") {
      message = "Kept as a new person. Nothing is added to the contact's page."
    } else {
      message = "Dismissed. Nothing was changed."
    }
  } catch {
    await revertToOpen(db, id, now)
    return { ok: false, status: 500, error: "Something went wrong. Nothing was lost; the card is back, try again." }
  }

  try {
    const { data, error } = await db
      .from("call_checks")
      .update({ status: "answered", answer, answered_by: deps.by, answered_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", id)
      .eq("status", "answering")
      .select("id")
    if (error || !Array.isArray(data) || data.length === 0) {
      await revertToOpen(db, id, now)
      return { ok: false, status: 500, error: "The change was made but the card could not be closed. It is back; press the same answer again." }
    }
  } catch {
    await revertToOpen(db, id, now)
    return { ok: false, status: 500, error: "The change was made but the card could not be closed. It is back; press the same answer again." }
  }
  return { ok: true, message }
}

/**
 * "Same person: link this email". Four steps, each safe to repeat:
 *   1. the booker's email becomes one of the CONTACT's alternate emails (so the next booking is recognised by itself)
 *   2. the stray lead the booking made is tagged as an existing client's booking (so Leads keeps hiding it)
 *   3. the call is saved under the contact (the call log the contact page reads)
 *   4. the link is claimed (a one-time link) and marked done, so a replay of the same booking does nothing more
 * Only for a link made for a CONTACT. A link made for a lead has no place to keep a second email: it is refused with a plain sentence.
 */
async function linkSamePerson(deps: AnswerDeps, row: CheckRow, now: Date): Promise<AnswerResult> {
  const { db } = deps
  const payload = row.payload ?? {}
  const bookerEmail = str(payload.booker_email)?.toLowerCase() ?? null
  if (!bookerEmail) return { ok: false, status: 422, error: "This card has no booker email, so there is nothing to link." }
  if (!row.booking_link_id) return { ok: false, status: 422, error: "This card is not tied to a link, so it cannot be linked to a person." }

  const { data: link, error: lerr } = await db.from("booking_links").select("id, contact_id, account_id, person_name, person_emails, kind_label, status, once, revoked_at").eq("id", row.booking_link_id).maybeSingle()
  if (lerr) return { ok: false, status: 500, error: "The link could not be read. Try again." }
  if (!link) return { ok: false, status: 404, error: "The link behind this card no longer exists." }
  const contactId = (link as LinkFacts).contact_id
  if (!contactId) return { ok: false, status: 422, error: "This link was made for a lead, and a lead keeps only one email, so this email cannot be linked. Choose Different person, or Dismiss." }

  const { data: contact, error: cerr } = await db.from("contacts").select("id, full_name, email, email_2, alt_emails, merged_into").eq("id", contactId).maybeSingle()
  if (cerr) return { ok: false, status: 500, error: "The contact could not be read. Try again." }
  if (!contact || contact.merged_into) return { ok: false, status: 422, error: "That contact is gone or was merged into another record. Pick Different person, or Dismiss." }

  // 1. the email
  if (!contactEmailSet(contact).includes(bookerEmail)) {
    const added = await (deps.addAlias ?? defaultAddAlias)(contact.id as string, bookerEmail)
    if (!added.ok) return { ok: false, status: 500, error: "The email could not be saved on the contact. Nothing else was changed; try again." }
  }

  // 2. the stray lead (found through this very booking, else by the booker's email)
  let leadId: string | null = row.lead_id
  let call: { scheduled_start: string | null; booked_at: string | null } | null = null
  if (row.calendly_event_uri) {
    const { data: lc, error: e } = await db.from("lead_calls").select("lead_id, scheduled_start, booked_at").eq("calendly_event_uri", row.calendly_event_uri).limit(1)
    if (e) return { ok: false, status: 500, error: "The booking could not be read. Try again." }
    if (lc && lc[0]) {
      leadId = leadId ?? (lc[0].lead_id as string)
      call = { scheduled_start: (lc[0].scheduled_start as string | null) ?? null, booked_at: (lc[0].booked_at as string | null) ?? null }
    }
  }
  if (!leadId) {
    const { data: ls, error: e } = await db.from("leads").select("id").ilike("email", escapeLike(bookerEmail)).order("created_at", { ascending: false }).limit(1)
    if (e) return { ok: false, status: 500, error: "The lead could not be read. Try again." }
    leadId = ls && ls[0] ? (ls[0].id as string) : null
  }
  if (leadId) {
    const { data: lead, error: e } = await db.from("leads").select("id, existing_client_contact_id").eq("id", leadId).maybeSingle()
    if (e) return { ok: false, status: 500, error: "The lead could not be read. Try again." }
    const tagged = (lead?.existing_client_contact_id as string | null) ?? null
    if (lead && tagged && tagged !== contact.id) return { ok: false, status: 409, error: "The lead this booking made is already linked to a different client. Look at it in Leads first." }
    if (lead && !tagged) {
      const r = await updateLeadColumnGuarded(db as unknown as LeadDb, { leadId, column: "existing_client_contact_id", newValue: contact.id as string, expected: null, hasExpected: true })
      if (isGuardedFailure(r)) return { ok: false, status: r.reason === "conflict" ? 409 : 500, error: r.message }
    }
  }

  // 3. the call under the contact
  const saved = await recordContactBooking(db, {
    contactId: contact.id as string,
    accountId: (link as LinkFacts).account_id,
    linkId: (link as LinkFacts).id,
    bookedAt: call?.booked_at ?? now.toISOString(),
    scheduledStart: call?.scheduled_start ?? null,
    eventUri: row.calendly_event_uri,
    eventTypeName: null,
  })
  if (!saved.ok) return { ok: false, status: 500, error: "The call could not be saved on the contact's page. The email and the lead were already updated; try again." }

  // 4. the link
  let linkNote = ""
  const l = link as LinkFacts
  if (l.once && l.status === "open" && !l.revoked_at) {
    const claim = await claimLink(db, l.id, { inviteeUri: row.dedupe_key, eventUri: row.calendly_event_uri, email: bookerEmail, now })
    if (claim.state === "error") return { ok: false, status: 500, error: "The link could not be closed. Everything else was saved; try again." }
    if (claim.state === "claimed") await markEffectsDone(db, l.id, now)
    else linkNote = " The link had already been closed."
  } else if (!l.once) {
    linkNote = " The link stays open because it can be used again."
  } else {
    linkNote = " The link had already been closed."
  }
  const name = (contact.full_name as string | null) ?? "the contact"
  return { ok: true, message: `Linked. ${bookerEmail} now belongs to ${name}, and the call is saved on their page.${linkNote}` }
}

