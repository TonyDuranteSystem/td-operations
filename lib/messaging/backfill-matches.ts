/**
 * Bulk version of findContactByPhone's matching rule — run across every
 * WhatsApp conversation with no lead/contact yet, instead of one at a time.
 *
 * Antonio, 2026-09-18: "can now the system read all chats and check if the
 * current numbers belongs to active client... show the client name if the
 * number is already in the crm" — then, after this surfaced a real
 * duplicate (two different named contacts sharing a number), corrected the
 * matching rule itself: "the entire number mst match not only some digits."
 *
 * Pure classification only — no I/O, so this is unit-testable without a
 * database. The route (app/api/inbox/whatsapp/backfill-matches) does the
 * fetch, calls this, and writes exactly the confident (single-candidate)
 * links; a group with 2+ full-number matches is a real ambiguity (the same
 * number really does exist on more than one CRM record) and is left
 * untouched for a human to pick, same principle as the single-conversation
 * banner never auto-deciding.
 */

import { digitsOnly } from "@/lib/messaging/phone"

export interface MatchCandidate {
  type: "lead" | "contact"
  id: string
  name: string
  phone: string | null
}

export interface GroupToMatch {
  groupId: string
  /** Digits-only form of the conversation's WhatsApp number. */
  digits: string
}

export interface ClassifiedGroup {
  groupId: string
  /** 0 = no match, 1 = confident, 2+ = ambiguous. */
  candidates: MatchCandidate[]
}

/** Exact full-number match only — see module doc for why. */
export function classifyGroups(groups: GroupToMatch[], candidates: MatchCandidate[]): ClassifiedGroup[] {
  const byDigits = new Map<string, MatchCandidate[]>()
  for (const c of candidates) {
    if (!c.phone) continue
    const d = digitsOnly(c.phone)
    if (d.length < 8) continue
    const arr = byDigits.get(d)
    if (arr) arr.push(c)
    else byDigits.set(d, [c])
  }
  return groups.map((g) => ({ groupId: g.groupId, candidates: byDigits.get(g.digits) ?? [] }))
}
