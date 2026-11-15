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

/** One card per link id; a link with nothing to show maps to null. */
export async function loadLinkCards(db: Db, rows: LinkCardRow[]): Promise<Map<string, CardModel | null>> {
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
    if (c) {
      out.set(r.id, personCard({ full_name: blank(c.full_name) ?? blank(r.person_name) ?? "Contact", email: c.email, phone: c.phone, language: c.language, portal_tier: c.portal_tier, companies: companies[c.id] ?? [] }))
    } else if (l) {
      out.set(r.id, leadCard(l))
    } else {
      out.set(r.id, linkOnlyCard(r))
    }
  }
  return out
}
