import { STUCK_CLAIM_MINUTES } from './send-claim'

/** Pure: the plain sentence Fax History shows under a sent fax that has no file to open (QA 2026-10-20). Says what really happened. */
export function faxNoCopyNote(d: { noCopyReason: string | null; filingStatus: string | null; savedAtPlace: string | null; source?: string | null }): string | null {
  if (d.source === 'stored_file') return 'Faxed straight from the storage. No copy was made, so there is nothing to open from this list.'
  if (d.noCopyReason === 'my_files') return 'Saved in My files. There is nothing to open from this list.'
  if (d.noCopyReason === 'personal_paper') {
    return d.savedAtPlace
      ? `Saved at ${d.savedAtPlace}. It is a person's own paper, so it is not opened from this list.`
      : "A person's own paper. No copy was kept, so there is nothing to open from this list."
  }
  if (d.filingStatus === 'failed') return 'The fax WAS sent, but the copy could not be saved where you chose.'
  if (d.filingStatus === 'pending') return 'The fax WAS sent. Saving the copy did not finish, so check where it should be.'
  return null
}


/**
 * Pure: how a `fax_claim` row (a send that has not been confirmed as sent) is shown in Fax History. Never as sent.
 * Younger than STUCK_CLAIM_MINUTES it is still running ("Sending…"); older, its outcome is unknown and staff must look in Faxage.
 */
export function claimShownAs(createdAt: string | null, now: Date = new Date()): 'sending' | 'unknown' {
  const t = createdAt ? Date.parse(createdAt) : NaN
  if (Number.isNaN(t)) return 'unknown'
  return now.getTime() - t < STUCK_CLAIM_MINUTES * 60_000 ? 'sending' : 'unknown'
}
