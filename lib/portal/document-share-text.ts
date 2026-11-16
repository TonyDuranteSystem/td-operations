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
  | {
      askable: true
      fileName: string
      locale: Locale
      defaultTopic: string
      targets: ShareTarget[]
      /** the Contact page's Message pop-up: who the message is for (shown in its title) */
      recipientName?: string
      /** an amber line shown under the choices (e.g. "no portal login yet") */
      notice?: string
      /** a plain grey line shown under the choices (e.g. who the portal alert goes to) — information, not a warning */
      info?: string
    }

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

/**
 * Pure: the topic choices for a plain staff message (the Contact page's Message pop-up). The first choice is "General" — an EMPTY
 * topic, which the chat route stores as no topic (portal_messages.topic NULL) — followed by the chat's own topics, no duplicates.
 */
export function messageTopicChoices(existing: string[]): string[] {
  return ["", ...topicChoices("", existing)]
}

/** How a person's portal login looks from the Contact page (the same facts as its Portal tab). */
export interface PortalLoginState { exists: boolean; suspended: boolean }

/**
 * Pure: the amber line the Message pop-up shows when the person cannot read the chat yet — null when their login is fine.
 * It states only what is known: the message is saved in the chat either way; without a working login the person cannot open it.
 */
export function contactMessageNotice(name: string, login: PortalLoginState): string | null {
  const who = name.trim() || "This person"
  if (!login.exists) return `${who} has no portal login yet. The message is saved in their chat, but they cannot read it until they have portal access.`
  if (login.suspended) return `${who}'s portal login is suspended. The message is saved in their chat, but they cannot read it while the login is suspended.`
  return null
}

/**
 * Pure: a company's chat is "closed" (the client cannot see it) unless its status is Active or Suspended. The one rule behind the
 * greyed choice in the Message pop-up and the greyed Message icon on the Accounts list.
 */
export function isChatClosedStatus(status: string | null | undefined): boolean {
  const s = status ?? ""
  return s !== "Active" && s !== "Suspended"
}

/** What is known about who can read a company's chat (the Accounts list's Message pop-up). */
export interface CompanyReach {
  /** how many people are linked to the company */
  contactCount: number
  /** how many of them have a working (existing, not suspended) portal login */
  contactsWithLogin: number
  /** active portal teammates with the chat capability */
  chatTeammates: number
}

/**
 * Pure: the amber line the company Message pop-up shows when NOBODY can read the chat yet — null as soon as one linked person has a
 * working login or one chat teammate is active. The message is saved in the chat either way.
 */
export function companyReachNotice(company: string, reach: CompanyReach): string | null {
  if (reach.contactsWithLogin > 0 || reach.chatTeammates > 0) return null
  const who = company.trim() || "This company"
  if (reach.contactCount === 0) return `Nobody is linked to ${who} yet, so nobody can read this message until someone is linked and has portal access. It is still saved in the chat.`
  return `Nobody at ${who} has a working portal login yet, so nobody can read this message until they do. It is still saved in the chat.`
}

/**
 * Pure: the grey line that says the truth about the alert. Everyone linked to the company can read a company message, but the portal
 * alert and the email go to ONE person (the staff send picks the last member who wrote in that chat, else the main contact).
 */
export function companyAlertInfo(alertName: string | null): string | null {
  const n = (alertName ?? "").trim()
  return n ? `The portal alert and email go to one person only: ${n}. Everyone linked to the company can read the message.` : null
}
