/**
 * Per-client unread-email bucketing for the Portal Chats GREEN dot.
 *
 * Input: the external (non-TD) sender/recipient emails of the unread Gmail
 * threads in support@, plus the CRM contact rows. Output: unread-thread
 * counts keyed by account_id and contact_id — the same bucket shape the
 * What's New (purple) counts use, so the thread list can key both dots
 * identically.
 */

export interface ContactEmailRow {
  contact_id: string
  account_id: string | null
  email: string | null
  email_2: string | null
}

export interface UnreadEmailBuckets {
  by_account: Record<string, number>
  by_contact: Record<string, number>
}

/** Extract the bare address from a "Name <email>" header value. */
export function extractEmailAddress(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/)
  return (match ? match[1] : headerValue).toLowerCase().trim()
}

/**
 * Count unread threads per client. `threadExternalEmails` is one entry per
 * unread thread: the set of external addresses seen on that thread. A thread
 * counts at most once per contact and once per linked account.
 */
export function bucketUnreadEmails(
  threadExternalEmails: Array<Set<string>>,
  contactRows: ContactEmailRow[]
): UnreadEmailBuckets {
  // email → contacts carrying it; contact → linked accounts
  const emailToContacts = new Map<string, Set<string>>()
  const contactToAccounts = new Map<string, Set<string>>()

  for (const row of contactRows) {
    for (const raw of [row.email, row.email_2]) {
      const email = raw?.toLowerCase().trim()
      if (!email) continue
      if (!emailToContacts.has(email)) emailToContacts.set(email, new Set())
      emailToContacts.get(email)!.add(row.contact_id)
    }
    if (row.account_id) {
      if (!contactToAccounts.has(row.contact_id)) contactToAccounts.set(row.contact_id, new Set())
      contactToAccounts.get(row.contact_id)!.add(row.account_id)
    }
  }

  const by_account: Record<string, number> = {}
  const by_contact: Record<string, number> = {}

  for (const emails of threadExternalEmails) {
    const contacts = new Set<string>()
    emails.forEach((email) => {
      emailToContacts.get(email)?.forEach((cid) => contacts.add(cid))
    })
    const accounts = new Set<string>()
    contacts.forEach((cid) => {
      by_contact[cid] = (by_contact[cid] ?? 0) + 1
      contactToAccounts.get(cid)?.forEach((aid) => accounts.add(aid))
    })
    accounts.forEach((aid) => {
      by_account[aid] = (by_account[aid] ?? 0) + 1
    })
  }

  return { by_account, by_contact }
}
