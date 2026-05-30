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
