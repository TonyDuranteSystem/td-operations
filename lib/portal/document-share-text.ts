/**
 * Client-safe half of the staff "eye" pop-up (no database here — the browser imports this):
 * the default message text and the shapes the pop-up and its context route share.
 * The server half (who can receive the message) is lib/portal/document-share-message.ts.
 */
import type { Locale } from "@/lib/locale"

export const DEFAULT_DOCUMENT_TOPIC = "Documents"

/** Pure: the default (editable) chat message for one or several newly visible documents. */
export function buildDocumentShareMessage(locale: Locale, fileNames: string[]): string {
  const names = fileNames.map((n) => n.trim()).filter(Boolean)
  if (names.length <= 1) {
    const n = names[0] ?? ""
    return locale === "it"
      ? `Un nuovo documento è stato aggiunto alla tua cartella: ${n}`
      : `A new document has been added to your folder: ${n}`
  }
  const list = names.map((n) => `• ${n}`).join("\n")
  return locale === "it"
    ? `Nuovi documenti sono stati aggiunti alla tua cartella:\n${list}`
    : `New documents have been added to your folder:\n${list}`
}

export interface ShareTarget {
  /** stable key for the choice list */
  key: string
  kind: "company" | "person"
  accountId: string | null
  contactId: string | null
  label: string
  /** the client cannot see a closed company's chat — staff cannot pick it */
  closed: boolean
  /** the document's own owner — pre-selected */
  isDefault: boolean
  /** topics already open in this chat (newest first) */
  topics: string[]
}

export type ShareContext =
  | { askable: false; reason: "personal" | "no_recipient" | "not_listed"; fileName: string }
  | { askable: true; fileName: string; locale: Locale; defaultTopic: string; targets: ShareTarget[] }

/** Pure: trim + cap a typed topic exactly as the chat route stores it (trim, 100 chars). */
export function normalizeTopic(raw: string): string {
  return raw.trim().slice(0, 100)
}

/** Pure: the topic list to offer — the default first, then the chat's own, no case-insensitive duplicates. */
export function topicChoices(defaultTopic: string, existing: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of [defaultTopic, ...existing]) {
    const k = t.trim().toLowerCase()
    if (k && !seen.has(k)) { seen.add(k); out.push(t.trim()) }
  }
  return out
}

/**
 * Pure: reuse the chat's spelling when a typed topic matches an existing one ignoring case/spaces
 * ("documents " must join "Documents", not open a duplicate tab).
 */
export function resolveTypedTopic(typed: string, existing: string[]): string {
  const t = normalizeTopic(typed)
  const hit = existing.find((e) => e.trim().toLowerCase() === t.toLowerCase())
  return hit ? hit.trim() : t
}

/**
 * Pure: do these contexts describe the SAME audience (same choices, same pre-selected target, same closed flags)?
 * One pop-up and one message for several files is only allowed when they do — otherwise the message could go to
 * the wrong chat for some of the files.
 */
export function sameShareAudience(a: ShareContext, b: ShareContext): boolean {
  if (!a.askable || !b.askable) return false
  if (a.targets.length !== b.targets.length) return false
  const sig = (c: Extract<ShareContext, { askable: true }>) => c.targets.map((t) => `${t.key}|${t.isDefault ? 1 : 0}|${t.closed ? 1 : 0}`).sort().join(',')
  return sig(a) === sig(b) && a.locale === b.locale
}
