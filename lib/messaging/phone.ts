/**
 * Canonical phone-number normalization for the WhatsApp/Telegram inbox.
 *
 * The system has historically stored the same real number in incompatible
 * shapes (bare digits from the historical import vs. `${digits}@c.us` from
 * the "New WhatsApp" flow). These two helpers are the ONE place that decides
 * both the canonical stored key and the E.164 shape providers expect —
 * everything that reads or writes a WhatsApp identifier should go through
 * them rather than re-deriving its own format.
 */

/** Strips everything but digits. */
export function digitsOnly(input: string): string {
  return input.replace(/\D/g, "")
}

/** Canonical `messaging_groups.external_group_id` shape for a 1:1 WhatsApp chat. */
export function toWhatsAppJid(input: string): string {
  return `${digitsOnly(input)}@c.us`
}

/** E.164 shape (`+<digits>`) a WhatsApp provider API expects, from a JID or any phone format. */
export function jidToE164(input: string): string {
  return `+${digitsOnly(input)}`
}
