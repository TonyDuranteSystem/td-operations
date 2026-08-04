/**
 * WHO COUNTS AS "THIS CLIENT" — a company and the people behind it are one.
 *
 * A document is filed against a company OR against a person: an ITIN letter,
 * a passport, a CP565 belong to the PERSON, not the LLC. So "does this file
 * belong to the client on screen" cannot be answered by comparing one id, and
 * "do these two files belong to different clients" cannot be answered by
 * comparing names — Acme LLC and Mario Rossi are different names for the same
 * client.
 *
 * EXTRACTED AND PURE ON PURPOSE. The first version of this lived inline in the
 * worker executor, where it could not be tested — and it was wrong in three
 * ways that only an adversarial read caught: it was skipped entirely on the
 * commonest Inbox shape, it picked an arbitrary link row so the same email
 * warned or did not depending on row order, and its one-pass expansion meant a
 * client's second company joined the family only if the rows happened to arrive
 * in the right order (the failing direction being the SILENT one, where a
 * genuinely separate company's document went out unflagged). None of that was
 * detectable by any test, because there was no seam to test.
 */

/** One `account_contacts` row: a person linked to a company. */
export interface ClientLink {
  account_id: string
  contact_id: string
}

export interface ClientFamily {
  /** Every id that still counts as this client — accounts AND contacts. */
  ids: Set<string>
  /** A person → the company that is canonical for their documents. */
  accountOfContact: Map<string, string>
}

/**
 * Resolve the family from link rows.
 *
 * DETERMINISTIC BY CONSTRUCTION:
 *  - the PINNED account always wins as a person's canonical company, so a
 *    client with two LLCs cannot flip depending on which link row arrives
 *    first;
 *  - with no pin, the lowest id wins — arbitrary, but STABLE, so the same
 *    email prepared twice reads the same both times (the worker is explicitly
 *    told to re-run a search on a later turn, so "same input, same answer"
 *    is load-bearing, not cosmetic);
 *  - membership is expanded to a FIXPOINT rather than in one pass, so
 *    company → person → their other company is reached whatever the row order.
 */
export function resolveClientFamily(
  links: ClientLink[],
  pinned: { accountId?: string | null; contactId?: string | null } = {},
): ClientFamily {
  const ids = new Set<string>()
  if (pinned.accountId) ids.add(pinned.accountId)
  if (pinned.contactId) ids.add(pinned.contactId)

  // Canonical company per person. Sorted first so the winner never depends on
  // the order the database happened to return.
  const accountOfContact = new Map<string, string>()
  const sorted = [...links].sort((a, b) =>
    a.contact_id === b.contact_id ? a.account_id.localeCompare(b.account_id) : a.contact_id.localeCompare(b.contact_id),
  )
  for (const l of sorted) {
    const current = accountOfContact.get(l.contact_id)
    if (current === undefined) accountOfContact.set(l.contact_id, l.account_id)
    // The screen's own company always wins over any other company the person
    // is also linked to.
    if (pinned.accountId && l.account_id === pinned.accountId) accountOfContact.set(l.contact_id, l.account_id)
  }

  // Expand to a fixpoint: any link with one end inside the family pulls the
  // other end in, repeatedly, until nothing new is added.
  let grew = true
  while (grew) {
    grew = false
    for (const l of sorted) {
      const hasAccount = ids.has(l.account_id)
      const hasContact = ids.has(l.contact_id)
      if (hasAccount && !hasContact) {
        ids.add(l.contact_id)
        grew = true
      } else if (hasContact && !hasAccount) {
        ids.add(l.account_id)
        grew = true
      }
    }
  }

  return { ids, accountOfContact }
}

/**
 * The canonical client for one document row — a person resolved to their
 * company where we know it, otherwise whichever id the row actually carries.
 */
export function ownerKeyFor(
  row: { account_id?: string | null; contact_id?: string | null },
  family: ClientFamily,
): string | undefined {
  if (row.account_id) return row.account_id
  if (row.contact_id) return family.accountOfContact.get(row.contact_id) ?? row.contact_id
  return undefined
}
