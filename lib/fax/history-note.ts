/** Pure: the plain sentence Fax History shows when a sent fax has no file to open (QA 2026-10-20). */
export function faxNoCopyNote(d: { noCopyReason: string | null; filingStatus: string | null; savedAtPlace: string | null }): string | null {
  if (d.noCopyReason === 'my_files') return 'Saved in My files. No copy is kept here, so there is nothing to open from this list.'
  if (d.noCopyReason === 'personal_paper') return "A person's own paper. No copy is kept, so there is nothing to open from this list."
  if (d.filingStatus === 'failed') return 'The fax WAS sent, but the copy could not be saved where you chose.'
  if (d.filingStatus === 'pending') return 'The fax WAS sent. Saving the copy did not finish, so check where it should be.'
  return null
}
