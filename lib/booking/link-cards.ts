/**
 * Booking page — "Links I made": the little card that opens when the pointer rests on a person's name (dev job a9285887, Antonio 15 Nov 2026).
 *
 * It is the SAME card the Contacts list shows (`personCard`), so what staff can see here is exactly what the Contacts page already shows them: name, email, phone, language,
 * the portal stage and the companies. Never the EIN, passport, ITIN or date of birth (nothing like that is even read). A lead gets a smaller card from the lead's own record;
 * someone who is not in the system yet gets only what the link itself knows (the name and email typed when it was made); a link with no name and no email has no card.
 *
 * Reads only. Never throws: a failed read falls back to what the link knows, and the list never loses a row because of a card.
 */

import { companiesByPerson, type PersonCompanyRow } from "@/lib/crm-lists/people"
import { personCard, type CardLine, type CardModel } from "@/lib/crm-lists/hover-cards"
import { whoBooked, type Booker } from "@/lib/booking/link-bookings"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

export interface LinkCardRow {
  id: string
  contact_id: string | null
  lead_id: string | null
  person_name: string | null
  person_emails: string[] | null
}

interface ContactBits {
  id: string
  full_name: string | null
  email: string | null
  phone: string | null
  language: string | null
  portal_tier: string | null
}

interface LeadBits {
  id: string
  full_name: string | null
  email: string | null
  phone: string | null
  language: string | null
  status: string | null
}

const blank = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim()
  return t ? t : null
}

/** What the link alone knows about someone who is not (or no longer) in the system. Null when it knows nothing. */
export function linkOnlyCard(row: Pick<LinkCardRow, "person_name" | "person_emails">): CardModel | null {
  const name = blank(row.person_name)
  const email = Array.isArray(row.person_emails) && row.person_emails.length ? blank(row.person_emails[0]) : null
  if (!name && !email) return null
  const lines: CardLine[] = []
  if (email) lines.push({ label: "Email", value: email })
  return { title: name ?? (email as string), subtitle: "Not in the system yet", lines }
}

export function leadCard(l: LeadBits): CardModel {
  const lines: CardLine[] = []
  const email = blank(l.email)
  const phone = blank(l.phone)
  const language = blank(l.language)
  if (email) lines.push({ label: "Email", value: email })
  if (phone) lines.push({ label: "Phone", value: phone })
  if (language) lines.push({ label: "Language", value: language })
  const status = blank(l.status)
  return { title: blank(l.full_name) ?? "Lead", subtitle: status ? `Lead · ${status}` : "Lead", lines }
}

const SHORT_LABEL = 30
/** A question shortened to fit the card's label column, cut at a word where it can be. */
export function shortLabel(q: string): string {
  if (q.length <= SHORT_LABEL) return q
  const cut = q.slice(0, SHORT_LABEL - 1)
  const at = cut.lastIndexOf(" ")
  return `${(at > 10 ? cut.slice(0, at) : cut).trimEnd()}…`
}

/** The card of someone who is only known from their booking (the link has no name or record to show). */
export function bookerCard(b: Booker): CardModel {
  const lines: CardLine[] = []
  if (b.email) lines.push({ label: "Email", value: b.email })
  if (b.phone) lines.push({ label: "Phone", value: b.phone })
  for (const a of b.answers) lines.push({ label: shortLabel(a.question), value: a.answer })
  return { title: b.name ?? b.email ?? "Booker", subtitle: "Booked this call", lines }
}

/**
 * Adds what the booking says about the booker to a card. No card yet = the booker's own card. A card that already exists keeps its lines and gains: "Booked by" when the booker is
 * not the person the link was made for, the booker's phone if the card has none, and the answers the booker gave.
 */
export function withBooker(card: CardModel | null, b: Booker | null, row: Pick<LinkCardRow, "person_name" | "person_emails">): CardModel | null {
  if (!b) return card
  if (!card) return bookerCard(b)
  const { differs } = whoBooked({ personName: row.person_name, personEmails: row.person_emails }, b)
  const lines: CardLine[] = [...card.lines]
  if (differs) {
    const who = [b.name, b.email].filter(Boolean).join(" · ")
    if (who) lines.push({ label: "Booked by", value: who })
  }
  // the booker's phone is the person's phone only when the booker IS the person; otherwise it is labelled as the booker's, never mixed with the person's own
  if (b.phone && differs) lines.push({ label: "Booker phone", value: b.phone })
  else if (b.phone && !lines.some((l) => l.label === "Phone")) lines.push({ label: "Phone", value: b.phone })
  for (const a of b.answers) lines.push({ label: shortLabel(a.question), value: a.answer })
  return { ...card, lines }
}

/** One card per link id; a link with nothing to show maps to null. `bookers` = who booked through each link (the latest booking), from the stored delivery. */
export async function loadLinkCards(db: Db, rows: LinkCardRow[], bookers: Map<string, Booker | null> = new Map()): Promise<Map<string, CardModel | null>> {
  const out = new Map<string, CardModel | null>()
  const contactIds = Array.from(new Set(rows.map((r) => r.contact_id).filter((v): v is string => !!v)))
  const leadIds = Array.from(new Set(rows.map((r) => r.lead_id).filter((v): v is string => !!v)))

  const contacts = new Map<string, ContactBits>()
  const leads = new Map<string, LeadBits>()
  let companies: Record<string, { company_name: string; status: string | null }[]> = {}

  try {
    const [c, l, links] = await Promise.all([
      contactIds.length ? db.from("contacts").select("id, full_name, email, phone, language, portal_tier").in("id", contactIds) : Promise.resolve({ data: [] }),
      leadIds.length ? db.from("leads").select("id, full_name, email, phone, language, status").in("id", leadIds) : Promise.resolve({ data: [] }),
      contactIds.length ? db.from("account_contacts").select("contact_id, account:accounts(company_name, status)").in("contact_id", contactIds) : Promise.resolve({ data: [] }),
    ])
    if (!c.error) for (const r of (c.data ?? []) as ContactBits[]) contacts.set(r.id, r)
    if (!l.error) for (const r of (l.data ?? []) as LeadBits[]) leads.set(r.id, r)
    if (!links.error) companies = companiesByPerson((links.data ?? []) as unknown as PersonCompanyRow[])
  } catch {
    /* fall back to what each link knows */
  }

  for (const r of rows) {
    const c = r.contact_id ? contacts.get(r.contact_id) : undefined
    const l = !c && r.lead_id ? leads.get(r.lead_id) : undefined
    let card: CardModel | null
    if (c) {
      card = personCard({ full_name: blank(c.full_name) ?? blank(r.person_name) ?? "Contact", email: c.email, phone: c.phone, language: c.language, portal_tier: c.portal_tier, companies: companies[c.id] ?? [] })
    } else if (l) {
      card = leadCard(l)
    } else {
      card = linkOnlyCard(r)
    }
    out.set(r.id, withBooker(card, bookers.get(r.id) ?? null, r))
  }
  return out
}
