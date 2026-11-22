/**
 * What the owner's Team page shows, decided without a database (dev job e59dd470, bug hunt).
 *
 * Two things can fail to load, and neither may look like an answer:
 *   - the list of logins: an unreadable list must not look like "this company has no team" — the page says it could not load it;
 *   - the list of who the owner shared their personal documents with: an unreadable list must not look like "nothing is shared"
 *     (the owner would believe a person who can see their papers cannot) — the page keeps the logins and says it cannot check the sharing.
 * Dependencies are passed in (tests); the page wires the real ones.
 */
export interface TeamPageDeps<T extends { id: string }> {
  /** Throws when the logins cannot be read. */
  listTeammates: (accountId: string) => Promise<T[]>
  /** Throws when the shares cannot be read. */
  getMySharedMemberIds: (accountId: string, ownerContactId: string) => Promise<Set<string>>
}

export type TeamPageData<T extends { id: string }> =
  | { kind: 'ok'; teammates: Array<T & { sharesMyDocs: boolean }>; sharesUnavailable: boolean }
  | { kind: 'failed' }

export async function loadTeamPageData<T extends { id: string }>(accountId: string, ownerContactId: string, deps: TeamPageDeps<T>): Promise<TeamPageData<T>> {
  let listed: T[]
  try {
    listed = await deps.listTeammates(accountId)
  } catch (err) {
    // eslint-disable-next-line no-console -- a failed load must be visible in the server log
    console.error('[portal-team] could not read the logins', err instanceof Error ? err.message : err)
    return { kind: 'failed' }
  }
  let shared = new Set<string>()
  let sharesUnavailable = false
  try {
    shared = await deps.getMySharedMemberIds(accountId, ownerContactId)
  } catch (err) {
    // eslint-disable-next-line no-console -- a failed load must be visible in the server log
    console.error('[portal-team] could not read the shares', err instanceof Error ? err.message : err)
    sharesUnavailable = true
  }
  return { kind: 'ok', teammates: listed.map((t) => ({ ...t, sharesMyDocs: shared.has(t.id) })), sharesUnavailable }
}
