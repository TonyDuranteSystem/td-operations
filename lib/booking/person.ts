/**
 * Booking page — who a link is for. Finds the person the maker picked, and searches people for the picker. The database client is passed in (service client, or a
 * fake in a test); nothing here throws: a failure comes back as { ok: false, error } in plain words.
 *
 * Three kinds of person (the same three the engine knows):
 *   contact  a person already in the CRM (a client, a partner's contact...). Their emails = email + email_2 + alternate emails (the alias-aware set the webhook
 *            also uses), so a booking made with their second address still counts as them.
 *   lead     a person who is only a lead so far (one email).
 *   new      someone not in the system: an optional name and an optional email typed on the page.
 */

import { isEstablishedClientContact } from "@/lib/calendly/existing-client-tag"
import { contactEmailSet, escapeLike } from "@/lib/operations/contact-email-aliases"
import type { PersonState } from "@/lib/booking/plan"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

export type PersonRef = { type: "contact"; id: string } | { type: "lead"; id: string } | { type: "new"; name?: string | null; email?: string | null }

export interface PersonFacts {
  state: PersonState
  /** contacts only: is this an established client (alias-aware check done here)? undefined = could not tell / not a contact */
  established?: boolean
  contactId: string | null
  accountId: string | null
  leadId: string | null
  name: string | null
  /** the emails the link will compare a booker against; may be empty */
  emails: string[]
  language: string | null
}

export type PersonResult = { ok: true; person: PersonFacts } | { ok: false; error: string }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/

export function cleanName(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 100) : ""
  return s || null
}

export function cleanEmail(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return EMAIL.test(s) && s.length <= 200 ? s : null
}

export async function loadPerson(db: Db, ref: PersonRef): Promise<PersonResult> {
  try {
    if (ref.type === "new") {
      const rawEmail = typeof ref.email === "string" ? ref.email.trim() : ""
      const email = cleanEmail(rawEmail)
      if (rawEmail && !email) return { ok: false, error: "That email does not look right. Check it, or leave it empty." }
      return { ok: true, person: { state: "new", contactId: null, accountId: null, leadId: null, name: cleanName(ref.name), emails: email ? [email] : [], language: null } }
    }
    if (!UUID.test(ref.id)) return { ok: false, error: "That person could not be found." }

    if (ref.type === "lead") {
      const { data, error } = await db.from("leads").select("id, full_name, email, language, converted_to_contact_id").eq("id", ref.id).maybeSingle()
      if (error) return { ok: false, error: "The person could not be read. Try again." }
      if (!data) return { ok: false, error: "That lead could not be found." }
      if (data.converted_to_contact_id) return { ok: false, error: "This lead has already become a contact. Pick the contact instead." }
      const email = cleanEmail(data.email)
      return { ok: true, person: { state: "lead", contactId: null, accountId: null, leadId: data.id as string, name: cleanName(data.full_name), emails: email ? [email] : [], language: (data.language as string | null) ?? null } }
    }

    const { data: c, error } = await db.from("contacts").select("id, full_name, email, email_2, alt_emails, language, portal_tier, merged_into").eq("id", ref.id).maybeSingle()
    if (error) return { ok: false, error: "The person could not be read. Try again." }
    if (!c) return { ok: false, error: "That contact could not be found." }
    if (c.merged_into) return { ok: false, error: "That contact was merged into another record. Pick the other one." }
    const [acc, sd] = await Promise.all([
      db.from("account_contacts").select("account_id, is_primary, ended_at").eq("contact_id", c.id).order("is_primary", { ascending: false }).limit(10),
      db.from("service_deliveries").select("id").eq("contact_id", c.id).limit(1),
    ])
    let established: boolean | undefined
    if (!acc.error && !sd.error) established = isEstablishedClientContact({ portal_tier: c.portal_tier ?? null, hasAccountLink: (acc.data?.length ?? 0) > 0, hasServiceDelivery: (sd.data?.length ?? 0) > 0 })
    const live = ((acc.data ?? []) as Array<{ account_id: string; ended_at: string | null }>).find((r) => !r.ended_at)
    return {
      ok: true,
      person: { state: "contact", established, contactId: c.id as string, accountId: live?.account_id ?? null, leadId: null, name: cleanName(c.full_name), emails: contactEmailSet(c), language: (c.language as string | null) ?? null },
    }
  } catch {
    return { ok: false, error: "The person could not be read. Try again." }
  }
}

// ─── the picker ──────────────────────────────────────────────────────────────

export interface PersonHit {
  type: "contact" | "lead"
  id: string
  name: string
  /** a short line under the name (the company, or what the lead is) */
  sub: string
  /** the badge: what this person is to us */
  badge: "Client" | "Lead" | "Partner" | "Contact"
  /** the kind the maker suggests for this person (the catalog slug) */
  suggestedKind: "client" | "lead" | "partner"
}

const MAX_PER_TABLE = 8

export function cleanQuery(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 60) : ""
}

/** People matching a name or an email. Reads only; a failure returns { ok: false } (never an empty list that looks like "nobody"). */
export async function searchPeople(db: Db, rawQuery: unknown): Promise<{ ok: true; hits: PersonHit[] } | { ok: false; error: string }> {
  const q = cleanQuery(rawQuery)
  if (q.length < 2) return { ok: true, hits: [] }
  const pattern = `%${escapeLike(q)}%`
  try {
    const [byName, byEmail, leadName, leadEmail] = await Promise.all([
      db.from("contacts").select("id, full_name, email, portal_tier, is_partner").is("merged_into", null).ilike("full_name", pattern).order("created_at", { ascending: false }).limit(MAX_PER_TABLE),
      db.from("contacts").select("id, full_name, email, portal_tier, is_partner").is("merged_into", null).ilike("email", pattern).order("created_at", { ascending: false }).limit(MAX_PER_TABLE),
      db.from("leads").select("id, full_name, email, status, converted_to_contact_id").is("converted_to_contact_id", null).ilike("full_name", pattern).order("created_at", { ascending: false }).limit(MAX_PER_TABLE),
      db.from("leads").select("id, full_name, email, status, converted_to_contact_id").is("converted_to_contact_id", null).ilike("email", pattern).order("created_at", { ascending: false }).limit(MAX_PER_TABLE),
    ])
    const failed = [byName, byEmail, leadName, leadEmail].find((r) => r.error)
    if (failed) return { ok: false, error: "The search could not run. Try again." }

    const contacts = new Map<string, { id: string; full_name: string | null; email: string | null; portal_tier: string | null; is_partner: boolean | null }>()
    for (const r of [...(byName.data ?? []), ...(byEmail.data ?? [])]) if (!contacts.has(r.id)) contacts.set(r.id, r)
    const leads = new Map<string, { id: string; full_name: string | null; email: string | null; status: string | null }>()
    for (const r of [...(leadName.data ?? []), ...(leadEmail.data ?? [])]) if (!leads.has(r.id)) leads.set(r.id, r)

    const ids = Array.from(contacts.keys())
    const companyOf = new Map<string, string>()
    const partnerIds = new Set<string>()
    if (ids.length) {
      const [links, partners] = await Promise.all([
        db.from("account_contacts").select("contact_id, account_id, is_primary, ended_at").in("contact_id", ids).is("ended_at", null).order("is_primary", { ascending: false }),
        db.from("client_partners").select("contact_id").in("contact_id", ids),
      ])
      const linkRows = (links.data ?? []) as Array<{ contact_id: string; account_id: string }>
      const accountIds = Array.from(new Set(linkRows.map((l) => l.account_id)))
      const names = new Map<string, string>()
      if (accountIds.length) {
        const { data: accs } = await db.from("accounts").select("id, company_name").in("id", accountIds)
        for (const a of (accs ?? []) as Array<{ id: string; company_name: string | null }>) if (a.company_name) names.set(a.id, a.company_name)
      }
      for (const l of linkRows) {
        const n = names.get(l.account_id)
        if (n && !companyOf.has(l.contact_id)) companyOf.set(l.contact_id, n)
      }
      for (const p of (partners.data ?? []) as Array<{ contact_id: string | null }>) if (p.contact_id) partnerIds.add(p.contact_id)
    }

    const hits: PersonHit[] = []
    for (const c of Array.from(contacts.values())) {
      const isPartner = partnerIds.has(c.id) || c.is_partner === true
      const established = !!c.portal_tier && ["formation", "onboarding", "active"].includes(c.portal_tier)
      const company = companyOf.get(c.id)
      hits.push({
        type: "contact",
        id: c.id,
        name: (c.full_name ?? "").trim() || c.email || "Unnamed contact",
        sub: company ?? c.email ?? "",
        badge: isPartner ? "Partner" : established || company ? "Client" : "Contact",
        suggestedKind: isPartner ? "partner" : established || company ? "client" : "lead",
      })
    }
    for (const l of Array.from(leads.values())) {
      hits.push({ type: "lead", id: l.id, name: (l.full_name ?? "").trim() || l.email || "Unnamed lead", sub: l.status ? `Lead · ${l.status}` : "Lead", badge: "Lead", suggestedKind: "lead" })
    }
    return { ok: true, hits: hits.slice(0, 12) }
  } catch {
    return { ok: false, error: "The search could not run. Try again." }
  }
}
