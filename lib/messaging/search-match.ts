/**
 * WhatsApp inbox search — a client-side filter over the already-fetched
 * conversation list (there is no Gmail-style server search for WhatsApp).
 * Matches a query against a conversation's display name, which IS the raw
 * phone number for a conversation with no linked contact/lead — so a plain
 * substring match on name plus a digits-only match covers both "search by
 * name" and "search by phone number" with one comparison. Antonio, 2026-09-19.
 *
 * Pure, so it's unit-testable without mounting the conversation list.
 */

import { digitsOnly } from "@/lib/messaging/phone"

export function matchesWhatsAppSearch(name: string | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const nameMatch = (name ?? "").toLowerCase().includes(q)
  if (nameMatch) return true
  const qDigits = digitsOnly(q)
  if (qDigits.length < 3) return false
  return digitsOnly(name ?? "").includes(qDigits)
}
