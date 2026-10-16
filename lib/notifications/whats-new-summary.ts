/**
 * What's New — the cross-client summary ("which clients have something new, and what") used by the New Calendar's What's New tab.
 * PURE: no database, no I/O. The route (GET ?summary=true in app/api/crm/admin-actions/whats-new/route.ts) reads the notes with
 * the SAME visibility rules as the purple dot and passes them here, so the Calendar's number is the dot's number.
 *
 * A "client" is the company when the note carries one, else the person. A note with neither is not counted (the dot does not count it either).
 */

export interface SummaryNote {
  account_id: string | null
  contact_id: string | null
  created_at: string
  /** The note's text with the chat-event marker already removed. */
  text: string
  event_key: string | null
}

export interface SummaryClient {
  /** "account:<id>" or "contact:<id>" — stable list key. */
  key: string
  accountId: string | null
  contactId: string | null
  name: string
  count: number
  latestAt: string
  latestEventKey: string | null
  latestText: string
}

export interface WhatsNewSummary {
  /** Unhandled, visible notes that belong to a company or a person: the purple dot's number. */
  total: number
  /** Clients that have at least one (before the cap). */
  clientCount: number
  clients: SummaryClient[]
  /** The list was cut to MAX_CLIENTS or the read hit its row ceiling: say so instead of looking complete. */
  truncated: boolean
}

export const MAX_CLIENTS = 300
export const TEXT_LENGTH = 160

/** Cut to TEXT_LENGTH characters without splitting an emoji (a surrogate pair) in half. */
function clip(text: string): string {
  const chars = Array.from(text)
  return chars.length <= TEXT_LENGTH ? text : chars.slice(0, TEXT_LENGTH).join('')
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Newest first, count per client, names from the lookup (a missing name says so instead of showing an id). */
export function groupWhatsNewSummary(
  notes: SummaryNote[],
  names: { accounts: Map<string, string | null>; contacts: Map<string, string | null> },
  opts: { readTruncated?: boolean; maxClients?: number } = {},
): WhatsNewSummary {
  const max = opts.maxClients ?? MAX_CLIENTS
  const byKey = new Map<string, SummaryClient>()
  let total = 0
  for (const n of notes) {
    if (!n.account_id && !n.contact_id) continue
    total++
    const key = n.account_id ? `account:${n.account_id}` : `contact:${n.contact_id}`
    const prior = byKey.get(key)
    if (!prior) {
      const name = (n.account_id ? names.accounts.get(n.account_id) : names.contacts.get(n.contact_id as string))?.trim()
      byKey.set(key, {
        key,
        accountId: n.account_id,
        contactId: n.account_id ? null : n.contact_id,
        name: name || (n.account_id ? 'Unnamed company' : 'Unnamed person'),
        count: 1,
        latestAt: n.created_at,
        latestEventKey: n.event_key,
        latestText: clip(oneLine(n.text)),
      })
      continue
    }
    prior.count++
    if (n.created_at > prior.latestAt) {
      prior.latestAt = n.created_at
      prior.latestEventKey = n.event_key
      prior.latestText = clip(oneLine(n.text))
    }
  }
  const all = Array.from(byKey.values()).sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : a.key < b.key ? -1 : 1))
  return {
    total,
    clientCount: all.length,
    clients: all.slice(0, max),
    truncated: all.length > max || !!opts.readTruncated,
  }
}
