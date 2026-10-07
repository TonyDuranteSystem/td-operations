/**
 * "Same name, different number" — pure rules for suggesting that an unlinked WhatsApp chat belongs to a client the CRM
 * already has (Antonio, 2026-10-07: a known client writes from a second number; the number-only match cannot see it).
 * It only ever SUGGESTS; a person clicks. Mirrors the SQL name rule used by the automatic linker
 * (wabridge_name_tokens / wabridge_names_agree: lowercase ASCII words of 3+ letters, one name's words fully inside the
 * other's), but is stricter for a suggestion: the shared name must have at least two words, because a lone first name
 * ("Davide") fits too many clients to be worth a prompt.
 */
import { digitsOnly } from "@/lib/messaging/phone"
import { isJunkChatName } from "@/lib/messaging/chat-name"

const FROM = "ÀÁÂÃÄÅĂĄàáâãäåăąÇĆČçćčÈÉÊËĚĘèéêëěęÌÍÎÏìíîïŁłÑŃñńÒÓÔÕÖŐØòóôõöőøŘřŕŠŚȘßšśșȚțÙÚÛÜŰùúûüűÝŸýÿŽŹŻžźż"
const TO = "aaaaaaaaaaaaaaaacccccceeeeeeeeeeeeiiiiiiiillnnnnoooooooooooooorrrsssssssttuuuuuuuuuuyyyyzzzzzz"

/** Comparable words of a name: lowercase ASCII letters, 3+ long, distinct (same as the SQL wabridge_name_tokens). */
export function nameTokens(name: string | null | undefined): string[] {
  const lower = (name ?? "").toLowerCase()
  let s = ""
  for (let k = 0; k < lower.length; k++) {
    const i = FROM.indexOf(lower[k])
    s += i >= 0 ? TO[i] : lower[k]
  }
  return Array.from(new Set(s.split(/[^a-z]+/).filter((w) => w.length >= 3))).sort()
}

/** True when the shorter name's words are all inside the longer one's AND that shared set has 2+ words. */
export function namesMatchForSuggestion(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (small.length < 2) return false
  return small.every((w) => big.includes(w))
}

/** Names worth comparing for a chat: its saved name and the names its senders use, minus junk (empty, our own business name, bare numbers). */
export function comparableChatNames(
  groupName: string | null | undefined,
  senderNames: Array<string | null | undefined>,
  externalGroupId?: string | null,
): string[] {
  const out: string[] = []
  for (const n of [groupName, ...senderNames]) {
    const t = (n ?? "").trim()
    if (!t || t.toLowerCase() === "td team" || isJunkChatName(t, externalGroupId)) continue
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out
}

export const CONTACT_PHONE_SLOTS = ["phone", "phone_2", "phone_3", "phone_4"] as const
export type ContactPhoneSlot = (typeof CONTACT_PHONE_SLOTS)[number]

/** Where the new number would go: nothing to do if it is already on the contact, a free slot, or no room. */
export function phoneSlotPlan(
  contact: Partial<Record<ContactPhoneSlot, string | null>>,
  numberDigits: string,
): { kind: "already" } | { kind: "slot"; slot: ContactPhoneSlot } | { kind: "full" } {
  const target = digitsOnly(numberDigits)
  for (const s of CONTACT_PHONE_SLOTS) if (digitsOnly(contact[s] ?? "") === target && target) return { kind: "already" }
  // A slot is free only when it is truly empty; free text such as "n/a" or "ask Maria" is somebody's note — never overwritten.
  for (const s of CONTACT_PHONE_SLOTS) if (!(contact[s] ?? "").trim()) return { kind: "slot", slot: s }
  return { kind: "full" }
}

/** Decide what the banner may offer: one clear client, several (text only), or nothing. */
export function suggestionKind<T>(matches: T[]): "one" | "several" | "none" {
  return matches.length === 1 ? "one" : matches.length > 1 ? "several" : "none"
}

/** Only a real 1:1 chat number can be matched to a person: group ids (@g.us) and linked-id (@lid) keys never are. */
export function isOneToOneNumberKey(externalGroupId: string): boolean {
  return /^\d{8,15}(@c\.us)?$/.test(externalGroupId.trim())
}
