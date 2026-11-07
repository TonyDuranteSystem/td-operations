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
  if (p.closedCompanyCount <= 0) return false
  const s = (p.offerStatus ?? "").toLowerCase()
  return s === "" || s === "completed"
}
