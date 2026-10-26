/**
 * TD Marketing — the Inbox's mailbox list and who may open which address (pure; dev job 9aec66fa). Antonio (and only Antonio) adds an address in CRM > Marketing > Settings; the
 * system's Gmail key can open ANY company mailbox, so this list is the whole wall: an address that is not in it is never opened, whoever asks, and the two CRM mailboxes
 * (support@, antonio@ and the aliases of support@) are refused even if a hand-edited setting names them. No database and no Gmail here.
 */
import { OWN_MAILBOX_ADDRESSES } from "@/lib/gmail"

export const INBOX_DOMAIN = "tonydurante.us"
const ADDRESS_RE = /^[a-z0-9._+-]{1,64}@tonydurante\.us$/

export interface InboxMailbox {
  address: string
  /** logins (user ids) who may open it, besides the person it belongs to and Antonio */
  people: string[]
  /** plain text added under every email written from this address ("" = none) */
  signature: string
}

export interface Viewer { id: string; email: string | null; admin: boolean }

/** The CRM's own mailboxes: never available to Marketing, whatever the setting says. */
export function isCrmMailbox(address: string): boolean {
  const a = address.trim().toLowerCase()
  const plain = a.replace(/\+[^@]*@/, "@")
  return (OWN_MAILBOX_ADDRESSES as readonly string[]).includes(plain) || /^(support|antonio)(\.[a-z]+)?@/.test(plain)
}

export type AddressCheck = { ok: true; address: string } | { ok: false; error: string }

/** The rules a NEW address must pass before the system even tries to open it. */
export function checkNewAddress(raw: unknown, existing: readonly string[]): AddressCheck {
  if (typeof raw !== "string") return { ok: false, error: "Type an email address." }
  const address = raw.trim().toLowerCase()
  if (!address) return { ok: false, error: "Type an email address." }
  if (address.length > 120 || /[\s<>(),;:"\\]/.test(address)) return { ok: false, error: "That email address does not look right." }
  if (!address.endsWith(`@${INBOX_DOMAIN}`)) return { ok: false, error: `Only ${INBOX_DOMAIN} addresses.` }
  if (!ADDRESS_RE.test(address)) return { ok: false, error: "That email address does not look right." }
  if (isCrmMailbox(address)) return { ok: false, error: "This mailbox belongs to the CRM." }
  if (existing.includes(address)) return { ok: false, error: "That address is already added." }
  return { ok: true, address }
}

/** Does this person see this mailbox? Antonio: every one; a person Antonio ticked: that one. Nothing else - a login address is NOT enough (a team owner can invite any address, so a matching login proves nothing). */
export function mayOpen(box: InboxMailbox, viewer: Viewer): boolean {
  if (isCrmMailbox(box.address)) return false
  if (viewer.admin) return true
  return box.people.includes(viewer.id)
}

export function visibleMailboxes(list: readonly InboxMailbox[], viewer: Viewer): InboxMailbox[] {
  return list.filter(b => mayOpen(b, viewer))
}

/** The one gate every Inbox route uses: the mailbox the browser named, if (and only if) this person may open it. */
export function findOpenable(list: readonly InboxMailbox[], viewer: Viewer, address: unknown): InboxMailbox | null {
  if (typeof address !== "string") return null
  const a = address.trim().toLowerCase()
  return list.find(b => b.address === a && mayOpen(b, viewer)) ?? null
}

/** Who may open a newly added address unless Antonio ticks others: only the person it belongs to (matched by login address) when he is on the team, else nobody but Antonio. */
export function defaultPeople(address: string, members: ReadonlyArray<{ user_id: string; email: string | null }>): string[] {
  return members.filter(m => (m.email ?? "").trim().toLowerCase() === address).map(m => m.user_id)
}
