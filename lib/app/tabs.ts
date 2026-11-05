/**
 * TD Social (iPhone app) — THE TAB LIST: one entry per tab, and the one place that says who may see it
 * (pure; dev job 2072bc3e, Step 2 pull request A; Council-reviewed plan of 5 Nov 2026).
 *
 * Everything else about a tab (how its unread number is counted, which alerts belong to it, what a lock screen may show) is added to
 * this same entry by the later pull requests, so a sixth tab is ONE new entry (a test adds a fake one to prove it).
 *
 * The RULES stay in code on purpose: they are security rules, reviewed and tested, never editable on a screen. Per-person CHOICES
 * (muted tabs, email switches) are data and arrive in pull request B. Nothing here names a person: access comes from the kind of
 * login, a Marketing team membership and the existing mailbox rule. That mailbox rule is CALLED (lib/inbox/mailbox-access.ts), not copied.
 *
 * The server decides; the phone only displays what comes back. The app mode / user-agent marker is a layout hint and never an input here.
 */
import { mailboxAllowedFor, PERSONAL_MAILBOX } from "@/lib/inbox/mailbox-access"

export type TabId = "talk" | "portal" | "whatsapp" | "inbox" | "marketing"

/** Facts about the signed-in person, gathered by the server (lib/app/identity.ts). Nothing in here comes from the phone. */
export interface AppIdentity {
  /** app_metadata.role, trimmed and lower-cased ("" when missing) */
  authRole: string
  /** the same admin rule the rest of the CRM uses (app_metadata or the code list; never user_metadata) */
  isAdmin: boolean
  /** TD staff: admin or team */
  isStaff: boolean
  /** an ACTIVE member of a LIVE Marketing team whose permissions include the chat */
  marketingChat: boolean
}

export interface TabEntry<Id extends string = TabId> {
  id: Id
  label: string
  allowed(who: AppIdentity): boolean
  /** the Inbox's mailboxes this person may open (only the Inbox has them) */
  mailboxes?(who: AppIdentity): string[]
}

export const SUPPORT_MAILBOX = "support"

const staffOnly = (who: AppIdentity): boolean => who.isStaff

export const TAB_LIST: readonly TabEntry[] = [
  { id: "talk", label: "TD Talk", allowed: staffOnly },
  { id: "portal", label: "Portal chats", allowed: staffOnly },
  { id: "whatsapp", label: "WhatsApp", allowed: staffOnly },
  {
    id: "inbox",
    label: "Inbox",
    allowed: staffOnly,
    // support@ is the shared team mailbox; antonio@ is his personal one and is admin-only (the existing rule decides)
    mailboxes: who => [SUPPORT_MAILBOX, ...(mailboxAllowedFor(PERSONAL_MAILBOX, who.isAdmin) ? [PERSONAL_MAILBOX] : [])],
  },
  {
    // Marketing Chat only. An admin sees it only as an ACTIVE member of a Marketing team (Antonio is; Jodi once he adds her); a staff
    // "team" login never does; a marketing login (Rocco's team) sees nothing else.
    id: "marketing",
    label: "Marketing",
    allowed: who => who.marketingChat && (who.isAdmin || who.authRole === "marketing"),
  },
]

export interface AppTab<Id extends string = TabId> { id: Id; label: string; mailboxes?: string[] }

/** The tabs this person may see, in list order. Empty for a client, a partner, an unknown login or a marketing login without chat. */
export function tabsFor<Id extends string = TabId>(who: AppIdentity, list: readonly TabEntry<Id>[] = TAB_LIST as unknown as readonly TabEntry<Id>[]): AppTab<Id>[] {
  const out: AppTab<Id>[] = []
  for (const entry of list) {
    if (!entry.allowed(who)) continue
    const tab: AppTab<Id> = { id: entry.id, label: entry.label }
    if (entry.mailboxes) tab.mailboxes = entry.mailboxes(who)
    out.push(tab)
  }
  return out
}

export type LoginKind = "staff" | "marketing" | "none"

/** What kind of login this is, for the app's first screen. Informational only: access is decided by `tabsFor`. */
export function loginKind(who: AppIdentity): LoginKind {
  if (who.isStaff) return "staff"
  if (who.authRole === "marketing") return "marketing"
  return "none"
}
