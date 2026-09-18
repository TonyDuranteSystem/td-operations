import { supabaseAdmin } from "@/lib/supabase-admin"
import { digitsOnly } from "@/lib/messaging/phone"

export interface WhatsAppContactMatch {
  type: "lead" | "contact"
  id: string
  name: string
  /** Present only for a contact — whether it's linked to any client account, for display. */
  accountName?: string | null
}

/**
 * Look up whether a WhatsApp number already has a CRM record — checked when a
 * conversation is opened, so Antonio sees who he's already talking to instead
 * of being asked to save someone twice.
 *
 * Matches on the FULL NUMBER, not a digit substring (Antonio, 2026-09-18,
 * after a last-8-digit match on the "Christian P." conversation surfaced a
 * real duplicate — two different named contacts sharing a number — and he
 * corrected: "the entire number mst match not only some digits"). A last-8
 * substring risks matching the wrong person once numbers from more than one
 * country are involved; a real duplicate (the same full number genuinely on
 * two records) still surfaces, just as an ambiguous case for a human to
 * resolve — see lib/messaging/backfill-matches.ts — rather than silently
 * picking one.
 *
 * Still queries with a last-8 `ilike` first (a normal indexed-friendly
 * substring scan, not the matching decision itself) to keep the candidate
 * set small, then confirms full-digit equality in JS before accepting a
 * match — phone numbers here are stored in inconsistent formats (spaces,
 * dashes, parens), so a raw string-equality WHERE clause would miss real
 * matches that this two-step shape still catches. Checks leads first, then
 * contacts (linked or not) — the first hit wins; a person is not expected to
 * be both.
 */
export async function findContactByPhone(phone: string): Promise<WhatsAppContactMatch | null> {
  const target = digitsOnly(phone)
  const last8 = target.slice(-8)
  if (last8.length < 8) return null
  const pattern = `%${last8}%`

  const { data: leads } = await supabaseAdmin
    .from("leads")
    .select("id, full_name, phone")
    .ilike("phone", pattern)
    .limit(10)
  const lead = (leads ?? []).find((l) => digitsOnly(l.phone ?? "") === target)
  if (lead) return { type: "lead", id: lead.id, name: lead.full_name }

  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, phone, phone_2, account_contacts(accounts(company_name))")
    .or(`phone.ilike.${pattern},phone_2.ilike.${pattern}`)
    .limit(10)
  const contact = (contacts ?? []).find(
    (c) => digitsOnly(c.phone ?? "") === target || digitsOnly(c.phone_2 ?? "") === target
  )
  if (contact) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accountName = (contact as any).account_contacts?.[0]?.accounts?.company_name ?? null
    return { type: "contact", id: contact.id, name: contact.full_name, accountName }
  }

  return null
}
