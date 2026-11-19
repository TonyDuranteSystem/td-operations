/**
 * Who is in a WhatsApp group, for the "Members" list in the Inbox. Pure helpers — the route does the database reads.
 *
 * A member with a phone number is matched to the CRM by the EXACT full number (same rule as everywhere else in Messaging:
 * every digit must match, never just the last few). A match is shown as a hint only; nothing is ever written from here.
 */
import { digitsOnly } from "@/lib/messaging/phone"
import type { GroupMember } from "@/lib/messaging/wabridge-groups"

export interface CrmPhoneRow {
  id: string
  full_name: string | null
  phone: string | null
}

export interface MemberView extends GroupMember {
  /** Who this number is in the CRM, when exactly one record holds it (null = unknown, or more than one holds it). */
  crm: { kind: "contact" | "lead"; id: string; name: string } | null
}

/** Last 4 digits — formatted numbers (dashes, spaces) keep these contiguous. Only used to NARROW the database search; the decision is always the full-number comparison below. */
export function phoneSearchTail(phone: string): string {
  const d = digitsOnly(phone)
  return d.slice(-4)
}

export function matchMembersToCrm(members: GroupMember[], contacts: CrmPhoneRow[], leads: CrmPhoneRow[]): MemberView[] {
  return members.map((m) => {
    if (!m.phone) return { ...m, crm: null }
    const target = digitsOnly(m.phone)
    const hits: Array<{ kind: "contact" | "lead"; id: string; name: string }> = []
    for (const c of contacts) {
      if (c.phone && digitsOnly(c.phone) === target && c.full_name) hits.push({ kind: "contact", id: c.id, name: c.full_name })
    }
    // a lead is only offered when no CONTACT holds the number (a converted lead is already the contact)
    if (hits.length === 0) {
      for (const l of leads) {
        if (l.phone && digitsOnly(l.phone) === target && l.full_name) hits.push({ kind: "lead", id: l.id, name: l.full_name })
      }
    }
    return { ...m, crm: hits.length === 1 ? hits[0] : null }
  })
}
