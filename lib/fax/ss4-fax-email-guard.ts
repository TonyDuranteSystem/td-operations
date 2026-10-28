/**
 * A FaxAge confirmation / failure email can only belong to an SS-4 that was already signed when the fax went out.
 * After an SS-4 Resubmit the corrected SS-4 is signed LATER than the old fax, so an old fax's email must never be matched to it
 * (it would close Luca's fax task and show "confirmed" for a form the IRS never received) — dev job 25e460aa.
 */

/** True when the email was sent before the SS-4 was signed (or the SS-4 is not signed at all) — it cannot be that SS-4's fax. */
export function faxEmailPredatesSs4(emailInternalDateMs: string | number | null | undefined, ss4SignedAt: string | null | undefined): boolean {
  if (!ss4SignedAt) return false // no signature time on record (legacy row): keep the existing behaviour
  const email = Number(emailInternalDateMs)
  if (!Number.isFinite(email) || email <= 0) return false // email time unreadable: never block a real confirmation on a guess
  const signed = Date.parse(ss4SignedAt)
  if (!Number.isFinite(signed)) return false
  return email < signed
}
