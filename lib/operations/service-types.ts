/**
 * Canonical `service_type` vocabulary.
 *
 * Originally mirrored the DB constraint `chk_sd_service_type`. Checked
 * 2026-09-27: that constraint no longer exists in sandbox or production
 * (only chk_sd_status remains) — this list is now the app-side vocabulary
 * for the strict pickers; keep it in step with the catalog.
 *
 * This module has NO runtime dependencies so it can be imported from both
 * server-only code (helpers, route handlers) and client components (the
 * bank-feed-tab modal's strict picker) without dragging the server stack
 * into the client bundle.
 *
 * Order is the canonical "common first" order chosen for the picker UI — it
 * matches the most-frequent values in `service_deliveries` so the user finds
 * the typical case at the top of the dropdown.
 */
export const VALID_SERVICE_TYPES = [
  "State Annual Report",
  "CMRA Mailing Address",
  "State RA Renewal",
  "Tax Return",
  "Tax Return One-Time",
  "Company Formation",
  "Annual Renewal",
  "EIN",
  "ITIN",
  "Banking Fintech",
  "Banking Physical",
  "Client Onboarding",
  "Client Offboarding",
  "Company Closure",
  "EIN Application",
  "CMRA",
  "Public Notary",
  "Shipping",
  "Support",
  "DBA",
  // Created at payment since S1 (2026-09-27): name changes + tracked add-ons.
  "Company Change Name",
  "EIN Change Name",
  "Consulting Call",
  "Certificate of Incumbency",
] as const

export type ValidServiceType = (typeof VALID_SERVICE_TYPES)[number]

export function isValidServiceType(value: string): value is ValidServiceType {
  return (VALID_SERVICE_TYPES as readonly string[]).includes(value)
}
