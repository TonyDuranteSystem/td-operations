/**
 * What the storage screen's red "Retry" reloads (dev job aa072623, bug-hunter round 4).
 *
 * The banner holds ONE message, but on the Storage page two things fail independently: the client list on the left and the storage open
 * on the right. The banner only remembers the LAST failure, so a Retry that repaired only that one left the other half of the screen on
 * "Loading…" with nothing running and no button. Retry therefore repairs everything that is still missing, not just what the banner names.
 * The embedded screen (a Documents tab) has no client list: it only ever has the storage to repair.
 */
export type RetryPlan = {
  /** 'refresh' = reload what is on screen (keeps the folder you are in); 'open' = nothing loaded yet, open the storage again; null = leave it */
  owner: 'refresh' | 'open' | null
  /** reload the client list on its own */
  list: boolean
}

export function planRetry(s: {
  /** the Documents-tab screen (scoped to one owner): no client list */
  embedded: boolean
  /** which load the banner is about */
  failedPart: 'nav' | 'owner'
  /** a storage is chosen (open or opening) */
  hasOwner: boolean
  /** the storage's top level has arrived */
  hasRoot: boolean
  /** the client list has arrived */
  hasList: boolean
}): RetryPlan {
  const owner = s.hasOwner && (s.failedPart === 'owner' || !s.hasRoot) ? (s.hasRoot ? 'refresh' : 'open') : null
  // refreshing the open storage reloads the client list as well on the Storage page, so ask for the list on its own only when that does not happen
  const list = !s.embedded && (s.failedPart === 'nav' || !s.hasList) && owner !== 'refresh'
  return { owner, list }
}
