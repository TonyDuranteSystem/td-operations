/**
 * Resolve the sender name to display for a portal chat message.
 *
 * Priority:
 *   1. the linked contact's full name (normal client/owner messages), then
 *   2. the stored sender_name on the row — this is where a TEAMMATE's display
 *      name is kept (teammates have no contact, so there's no contact name), then
 *   3. null (no name → the UI falls back to its generic label).
 *
 * Empty/whitespace strings are treated as absent so the column default ('') never
 * shows as a blank name.
 */
export function pickChatSenderName(
  contactFullName?: string | null,
  storedSenderName?: string | null,
): string | null {
  const contact = contactFullName?.trim()
  if (contact) return contact
  const stored = storedSenderName?.trim()
  if (stored) return stored
  return null
}

/**
 * Label for a STAFF-side portal message in the internal chat readers
 * (`portal_chat_read` / `portal_chat_inbox` and the Slack/Hermes worker tools).
 *
 * A staff message must NEVER be labelled with a contact/member name. On an admin
 * send with only an account_id, the row's `contact_id` is just a ROUTING TAG — an
 * arbitrary linked account member picked via `.limit(1)` so the message lands in
 * the client's contact-scoped thread (see app/api/portal/chat/route.ts) — NOT the
 * author. Rendering that tag as the sender wrongly attributed staff replies to a
 * company member (e.g. "Admin (Gaia Pellegrinelli)" for a message support sent).
 *
 *   - admin  → "TD Team"
 *   - system → "TD Team (auto-reply)" — an automated responder (e.g. the
 *     office-closed after-hours reply), flagged so it reads apart from staff
 *   - anything else (client / teammate) → null, so the caller supplies its own
 *     client-side label (contact name, sender_context, etc.)
 */
export function staffChatSenderLabel(senderType?: string | null): string | null {
  if (senderType === "admin") return "TD Team"
  if (senderType === "system") return "TD Team (auto-reply)"
  return null
}

/**
 * Full sender label for the MCP `portal_chat_read` reader: staff → the shared
 * "TD Team" label; client/teammate → "Client (Name)" (contact full name, else the
 * stored teammate sender_name, else the bare "Client" label).
 */
export function formatMcpChatSenderLabel(
  senderType: string,
  contactFullName?: string | null,
  storedSenderName?: string | null,
): string {
  const staff = staffChatSenderLabel(senderType)
  if (staff) return staff
  const name = pickChatSenderName(contactFullName, storedSenderName)
  return name ? `Client (${name})` : "Client"
}
