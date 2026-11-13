import { supabaseAdmin } from "@/lib/supabase-admin"
import { digitsOnly } from "@/lib/messaging/phone"

export interface WhatsAppContactMatch {
  type: "lead" | "contact"
  id: string
  name: string
  /** Present only for a contact — whether it's linked to any client account, for display. */
  accountName?: string | null
  /** A contact's first company, so linking the chat to this person can also link the company. */
  accountId?: string | null
}

export interface LeadPhoneRow {
  id: string
  full_name: string | null
  phone: string | null
  converted_to_contact_id?: string | null
  is_test?: boolean | null
}

export interface ContactPhoneRow {
  id: string
  full_name: string | null
  phone: string | null
  phone_2?: string | null
  phone_3?: string | null
  phone_4?: string | null
  is_test?: boolean | null
  account_contacts?: Array<{ account_id?: string | null; accounts?: { company_name?: string | null } | null }> | null
}

/** A real phone number: nothing shorter than 8 digits is ever compared (a blank or tiny value can never equal a chat's number). */
const MIN_DIGITS = 8
const MAX_DIGITS = 15

/**
 * Which leads and contacts hold this exact phone number — however it is WRITTEN. Digits only: spaces, dashes, brackets, "+" never matter,
 * and there is no country or format rule. The ENTIRE number must match, never a part of it (Antonio, 2026-09-18, after a last-8 match
 * linked the wrong person; 2026-11-13: "flexible, no hardcoded on the number, only lead or contact"). A contact is matched on any of its
 * four phone slots, a lead on its phone. Test records are ignored; the caller already left out merged contacts.
 *
 * Every match is returned — contacts first, then leads — and the caller shows them as choices: nothing here picks a person.
 * A lead that is recorded as having become one of the matched contacts is the SAME person, so only the contact is shown.
 */
export function matchPhoneRecords(phone: string, leads: LeadPhoneRow[], contacts: ContactPhoneRow[]): WhatsAppContactMatch[] {
  const target = digitsOnly(phone)
  if (target.length < MIN_DIGITS || target.length > MAX_DIGITS) return []
  const same = (v: string | null | undefined) => {
    const d = digitsOnly(v ?? "")
    return d.length >= MIN_DIGITS && d === target
  }

  const contactMatches = new Map<string, WhatsAppContactMatch>()
  for (const c of contacts) {
    if (c.is_test === true || contactMatches.has(c.id)) continue
    if (![c.phone, c.phone_2, c.phone_3, c.phone_4].some(same)) continue
    const link = c.account_contacts?.[0]
    contactMatches.set(c.id, {
      type: "contact",
      id: c.id,
      name: c.full_name ?? "",
      accountName: link?.accounts?.company_name ?? null,
      accountId: link?.account_id ?? null,
    })
  }

  const leadMatches = new Map<string, WhatsAppContactMatch>()
  for (const l of leads) {
    if (l.is_test === true || leadMatches.has(l.id) || !same(l.phone)) continue
    if (l.converted_to_contact_id && contactMatches.has(l.converted_to_contact_id)) continue
    leadMatches.set(l.id, { type: "lead", id: l.id, name: l.full_name ?? "" })
  }

  return [...Array.from(contactMatches.values()), ...Array.from(leadMatches.values())]
}

const PAGE = 1000

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>

/** Reads every row, page by page (the database silently stops at 1,000 rows otherwise). Any error is thrown: a failed read must never look like "no match". */
async function readAll<T>(label: string, page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE) return out
  }
}

/**
 * Look up whether a WhatsApp number already has CRM records — checked when a conversation is opened, so Antonio sees who he is already
 * talking to instead of being asked to save someone twice. Reads every stored phone and compares the digits (see `matchPhoneRecords`);
 * the old shortcut of searching for the last 8 digits as text missed every number written with spaces ("+39 349 703 7513").
 * Throws when the database cannot be read — the caller must show that as a failure, not as "nobody matches".
 */
export async function findAllMatchesByPhone(phone: string): Promise<WhatsAppContactMatch[]> {
  const target = digitsOnly(phone)
  if (target.length < MIN_DIGITS || target.length > MAX_DIGITS) return []

  const [leads, contacts] = await Promise.all([
    readAll<LeadPhoneRow>("leads", (from, to) =>
      supabaseAdmin
        .from("leads")
        .select("id, full_name, phone, converted_to_contact_id, is_test")
        .not("phone", "is", null)
        .order("id")
        .range(from, to) as unknown as Page<LeadPhoneRow>
    ),
    readAll<ContactPhoneRow>("contacts", (from, to) =>
      supabaseAdmin
        .from("contacts")
        .select("id, full_name, phone, phone_2, phone_3, phone_4, is_test, account_contacts(account_id, accounts(company_name))")
        .is("merged_into", null)
        .or("phone.not.is.null,phone_2.not.is.null,phone_3.not.is.null,phone_4.not.is.null")
        .order("id")
        .range(from, to) as unknown as Page<ContactPhoneRow>
    ),
  ])
  return matchPhoneRecords(phone, leads, contacts)
}
