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
 * of being asked to save someone twice. Matches on the LAST 8 DIGITS, same
 * tolerance as `lead_create`'s own duplicate check (lib/mcp/tools/leads.ts) —
 * phone numbers in this system show up in inconsistent formats (with/without
 * country code, spaces, dashes), so a strict equality check would miss real
 * matches. Checks leads first, then contacts (linked or not) — the first hit
 * wins; a person is not expected to be both.
 */
export async function findContactByPhone(phone: string): Promise<WhatsAppContactMatch | null> {
  const last8 = digitsOnly(phone).slice(-8)
  if (last8.length < 8) return null
  const pattern = `%${last8}%`

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, full_name")
    .ilike("phone", pattern)
    .limit(1)
    .maybeSingle()
  if (lead) return { type: "lead", id: lead.id, name: lead.full_name }

  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, account_contacts(accounts(company_name))")
    .or(`phone.ilike.${pattern},phone_2.ilike.${pattern}`)
    .limit(1)
    .maybeSingle()
  if (contact) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accountName = (contact as any).account_contacts?.[0]?.accounts?.company_name ?? null
    return { type: "contact", id: contact.id, name: contact.full_name, accountName }
  }

  return null
}
