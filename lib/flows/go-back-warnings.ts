/**
 * What a "Go Back" does besides moving the job one step back, said in the question BEFORE it is pressed (production end-to-end test 2026-11-07,
 * dev job eaa4747e): the saved IRS tracking number is always deleted by a step back (a stale number must never keep being checked), and going
 * back from a finished closure job does NOT reopen the company that its last step closed. Both used to happen without a word.
 *
 * Pure — no database. The same facts are repeated by the server after the move (`revertServiceDelivery` warnings).
 */
export function goBackExtraWarnings(p: { hasTrackingNumber: boolean; closureCompanyClosed: boolean }): string[] {
  const out: string[] = []
  if (p.hasTrackingNumber) out.push('It also deletes the saved IRS tracking number — you will have to enter it again before the job can move on.')
  if (p.closureCompanyClosed) out.push('The company is already Closed and going back does NOT reopen it: its portal stays off and the services and invoices cancelled when it closed stay cancelled.')
  return out
}
