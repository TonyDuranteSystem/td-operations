/**
 * Client portal, Documents page: where the client's OWN fresh uploads that staff have not reviewed yet are listed.
 *
 * An upload is saved hidden on purpose until staff show it to the client (portal_visible stays false), so by the visibility rule alone it
 * vanished from the Documents page right after the upload (the Tax page already lists such uploads as "Waiting for review"). The page keeps
 * the rule: these rows are listed BY NAME with a "Waiting for review" tag and cannot be opened (the download route still refuses them).
 *
 * Pure: no database. The page works out which rows are the client's own (lib/portal/client-store-docs.ts `listDocsWithOwnUploads`) and
 * hands them here to be placed in the right list.
 */

export interface WaitingPlaceable {
  id: string
  category: number | null
  created_at: string
}

/** Personal papers (passport, ID...) are category 2; they belong in "My Documents", never in the company list. */
export const PERSONAL_UPLOAD_CATEGORY = 2

/**
 * Adds the waiting uploads to the company list and the personal list (newest first), skipping any already listed there or in a flow
 * group. A personal one goes to "My Documents" only when the person has that list (a team member has none, so it is dropped).
 */
export function placeWaitingUploads<T extends WaitingPlaceable>(input: {
  companyDocs: T[]
  myDocs: T[]
  waiting: T[]
  /** Ids already shown anywhere on the page (flow groups included). */
  alreadyListedIds: ReadonlySet<string>
  /** True for a signed-in client with a personal list; false for a team member. */
  hasPersonalList: boolean
}): { companyDocs: T[]; myDocs: T[]; waitingIds: Set<string> } {
  const { companyDocs, myDocs, waiting, alreadyListedIds, hasPersonalList } = input
  const fresh = waiting.filter(d => !alreadyListedIds.has(d.id))
  const newestFirst = (a: T, b: T) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  const toCompany = fresh.filter(d => d.category !== PERSONAL_UPLOAD_CATEGORY)
  const toMine = hasPersonalList ? fresh.filter(d => d.category === PERSONAL_UPLOAD_CATEGORY) : []
  return {
    companyDocs: [...companyDocs, ...toCompany].sort(newestFirst),
    myDocs: [...myDocs, ...toMine].sort(newestFirst),
    waitingIds: new Set([...toCompany, ...toMine].map(d => d.id)),
  }
}
