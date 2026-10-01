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

/**
 * The line's OWN registered WhatsApp Business display name — confirmed live (2026-10-01) via GOWA's own
 * `/app/devices`, which reports `"name": "Tony Durante LLC"` for this line. GOWA was found, the same day,
 * reporting this exact string as the "name" of several unrelated 1:1 client chats (via `/chats`) — our own
 * business identity leaking onto other people's conversations, upstream of anything this codebase controls.
 * Treated as junk wherever a chat's name is decided or saved, the same way an empty/"Unknown"/digits-only
 * name already is — never shown or stored as if it were a real client's name. Kept here as the single
 * place this repo defines it; `wabridge_apply_names` (the database function doing the actual write from the
 * phone-names sync) carries the identical literal — SQL can't import this file, so the two must be kept in
 * sync by hand, the same documented trade-off already made for the mime→extension tables elsewhere in
 * messaging. If the line's registered business name is ever deliberately changed, this constant needs
 * updating too.
 */
export const OWN_BUSINESS_NAME = "Tony Durante LLC"

/** A "name" that is really no name: empty, "Unknown", just the phone number, or our own business identity. */
export function isJunkChatName(name: string | null | undefined, externalGroupId?: string | null): boolean {
  const n = (name ?? "").trim()
  if (!n) return true
  if (n.toLowerCase() === "unknown") return true
  if (n.toLowerCase() === OWN_BUSINESS_NAME.toLowerCase()) return true
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
