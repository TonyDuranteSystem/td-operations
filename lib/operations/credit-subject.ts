/**
 * WHO holds the credit — the single person-resolution used by every WS-A surface
 * (dev job c0a61e44).
 *
 * Two surfaces need to answer "which person is this?" from an email address: the
 * paid strategy call, which records the credit, and offer creation, which shows
 * it. They MUST agree. If they resolve differently, the offer promises a
 * deduction against a person the ledger never credited — the exact failure this
 * workstream exists to prevent. So there is ONE lookup here, not a copy in each.
 *
 * WHY THIS IS NOT `resolveMemberContactId`. That resolver keys on email PLUS
 * name and CREATES a contact when nothing matches, because a family LLC can put
 * two distinct members on one address. Neither behaviour is right here: the name
 * on an offer is whatever staff typed and need not match the contact record, and
 * an offer must never bring a person into existence as a side effect of being
 * written. Same primitive (`normalizeEmail`), deliberately different policy.
 *
 * The resolver REPORTS; it does not decide. Each caller applies its own policy
 * explicitly, because their obligations genuinely differ: recording money must
 * always succeed, while displaying a deduction must be certain or stay silent.
 * Making that difference visible here is the point — when it lived implicitly in
 * two separate queries, one of them quietly took an arbitrary row.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeEmail } from "@/lib/members/member-identity"

export interface ContactOnEmail {
  id: string
  full_name: string | null
  created_at: string | null
}

export type CreditSubject =
  /** Exactly one person on this address — safe to both credit and display. */
  | { kind: "resolved"; contactId: string; email: string }
  /**
   * Several people share this address. Recording money may still proceed (it
   * picks the oldest, deterministically) but a DISPLAY must not guess — showing
   * one person another's balance is the worst outcome available here.
   */
  | { kind: "ambiguous"; contacts: ContactOnEmail[]; email: string }
  /** Nobody on this address yet. */
  | { kind: "unknown"; email: string }
  /** No address to resolve from. */
  | { kind: "no_email" }

/**
 * Find everyone on an email address. Case-insensitive, oldest first, so any
 * tie-break a caller makes is deterministic rather than whatever Postgres
 * happened to return — the previous paid-call lookup took the first row of an
 * unordered query, which on a duplicated address is a coin toss.
 */
export async function resolveCreditSubject(
  email: string | null | undefined,
  supabase: SupabaseClient,
): Promise<CreditSubject> {
  const normalized = normalizeEmail(email)
  if (!normalized) return { kind: "no_email" }

  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, created_at")
    .ilike("email", normalized)
    .order("created_at", { ascending: true })

  if (error) {
    // Treat a failed lookup as "cannot tell", never as "nobody" — a swallowed
    // error must not silently become a decision that no credit exists.
    console.error(`[resolveCreditSubject] lookup failed for ${normalized}:`, error.message)
    return { kind: "ambiguous", contacts: [], email: normalized }
  }

  const contacts = (data ?? []) as ContactOnEmail[]
  if (contacts.length === 0) return { kind: "unknown", email: normalized }
  if (contacts.length === 1) return { kind: "resolved", contactId: contacts[0].id, email: normalized }
  return { kind: "ambiguous", contacts, email: normalized }
}

/**
 * The person to RECORD money against. Recording must always succeed, so an
 * ambiguous address falls back to the oldest contact rather than refusing — but
 * the caller is told, so it can raise the discrepancy for staff instead of
 * silently picking someone.
 */
export function subjectForRecording(
  subject: CreditSubject,
): { contactId: string | null; ambiguous: boolean } {
  if (subject.kind === "resolved") return { contactId: subject.contactId, ambiguous: false }
  if (subject.kind === "ambiguous") {
    return { contactId: subject.contacts[0]?.id ?? null, ambiguous: true }
  }
  return { contactId: null, ambiguous: false }
}

/**
 * The person to DISPLAY a balance for. Certain or nothing: an ambiguous address
 * yields no id, so the offer stays silent rather than quoting a stranger's money.
 */
export function subjectForDisplay(subject: CreditSubject): string | null {
  return subject.kind === "resolved" ? subject.contactId : null
}
