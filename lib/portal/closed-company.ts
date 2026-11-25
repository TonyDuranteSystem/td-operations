/**
 * When the portal home says "your company has been closed" instead of the new-client welcome screen
 * (Company Closure Part C, dev job a6bbea09).
 *
 * A closed company is hidden from the portal (getPortalAccounts lists only Active / Suspended), so a client whose only company was
 * closed has NO company, and the home page fell back to the lead / onboarding welcome — "Thank you for your payment! Complete your
 * setup so we can start working on your services" — for a client whose closure had just finished.
 *
 * The notice is shown when the person has at least one Closed company AND nothing new is in progress for them: no offer at all, or
 * the latest offer is already completed (paid and activated — it was the closure itself). An offer that is still draft / sent /
 * viewed / signed means the person is buying something new, and the welcome flow for that is the right screen.
 * Pure, so the page and the tests use the same rule.
 */
export function showClosedCompanyNotice(p: { closedCompanyCount: number; offerStatus: string | null | undefined }): boolean {
  return noticeApplies(p.closedCompanyCount, p.offerStatus)
}

/**
 * The same screen problem for a company that is OFFBOARDING (dev job 31dfd3a6, found 24 Nov 2026 when staff offboarded several
 * companies): an offboarding company is hidden from the portal just like a closed one, so a client whose companies are all
 * offboarding has NO company and landed on "Thank you for your payment! Complete your setup…". The same rule applies — the notice
 * shows unless the person is buying something new — and the login is NOT touched: they can still sign in and chat with us.
 * A client who still has an Active or Suspended company never reaches this branch (the portal shows that company).
 */
export function showOffboardingCompanyNotice(p: { offboardingCompanyCount: number; offerStatus: string | null | undefined }): boolean {
  return noticeApplies(p.offboardingCompanyCount, p.offerStatus)
}

function noticeApplies(companyCount: number, offerStatus: string | null | undefined): boolean {
  if (companyCount <= 0) return false
  const s = (offerStatus ?? "").toLowerCase()
  return s === "" || s === "completed"
}
