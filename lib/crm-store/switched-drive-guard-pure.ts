/** Pure rule used by the Drive write guard (kept free of database imports so it can be unit-tested alone). */

/** Statuses of companies that are finished: their Drive folders are archive, nobody works in them. */
const FINISHED_STATUSES = new Set(["Closed", "Cancelled"])

/**
 * Pure: a person SHARES A DRIVE COMPANY when they are linked to a company that is still on Drive and still alive (not Closed /
 * Cancelled). Their Drive "contact folder" is then that company's "2. Contacts" (REBIS, YBR …): a storage opened for the person
 * (a lead form does that) must neither lock that folder nor capture the company's Drive saves into this one person's storage.
 */
export function contactsSharingDriveCompany(
  links: Array<{ contact_id: string; account_id: string }>,
  accountStatus: ReadonlyMap<string, string | null>,
  switchedAccounts: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const l of links) {
    if (switchedAccounts.has(l.account_id)) continue
    if (!accountStatus.has(l.account_id)) continue // unknown account: not evidence of a live Drive company
    if (FINISHED_STATUSES.has(accountStatus.get(l.account_id) ?? "")) continue
    out.add(l.contact_id)
  }
  return out
}

