/**
 * The name a WhatsApp chat shows in the CRM Inbox — never "Unknown".
 *
 * Priority (Antonio, 2026-09-24: "the CRM must recognize the phone number, not Unknown … when I save the
 * number on the phone or in the CRM with name and last name, the two must be updated"):
 *   1. the linked CRM contact's name (the CRM is the source of truth for people it knows)
 *   2. the linked lead's name
 *   3. the linked company's name
 *   4. the name saved on the phone (synced from WhatsApp into messaging_groups.group_name)
 *   5. the phone number itself, formatted (+<digits>)
 * The linked names are read LIVE, so renaming the contact/lead in the CRM changes the chat at once, and a
 * new saved name from the phone lands in group_name through the bridge's name sync.
 */

const digits = (s: string) => s.replace(/\D/g, "")

/** A "name" that is really no name: empty, "Unknown", or just the phone number. */
export function isJunkChatName(name: string | null | undefined, externalGroupId?: string | null): boolean {
  const n = (name ?? "").trim()
  if (!n) return true
  if (n.toLowerCase() === "unknown") return true
  const nd = digits(n)
  // digits-only (or a phone-looking string) — e.g. WhatsApp echoing the number back as the "name"
  if (nd.length >= 6 && nd.length >= n.replace(/[\s+()\-.]/g, "").length) return true
  if (externalGroupId && nd && nd === digits(externalGroupId)) return true
  return false
}

/** `393339980702@c.us` / `393339980702` → `+393339980702`; anything without a usable number is returned as-is. */
export function formatChatPhone(externalGroupId: string | null | undefined): string {
  const raw = (externalGroupId ?? "").trim()
  const d = digits(raw.split("@")[0])
  return d.length >= 6 ? `+${d}` : raw || "Unknown number"
}

export interface ChatNameInput {
  contactName?: string | null
  leadName?: string | null
  accountName?: string | null
  /** messaging_groups.group_name — the phone's saved contact name (or the sender's WhatsApp name). */
  savedName?: string | null
  externalGroupId?: string | null
}

export function resolveChatName(i: ChatNameInput): string {
  for (const linked of [i.contactName, i.leadName, i.accountName]) {
    if (linked && linked.trim()) return linked.trim()
  }
  if (!isJunkChatName(i.savedName, i.externalGroupId)) return (i.savedName as string).trim()
  return formatChatPhone(i.externalGroupId)
}
