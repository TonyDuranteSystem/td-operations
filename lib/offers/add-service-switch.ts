/**
 * The switch for "add a new service from the offer" (flexible-offer track, part 4).
 * OFF by default and fails CLOSED: a missing row, a failed read, or anything but a stored `true` means OFF, and
 * OFF means the Create Offer dialog is exactly what it always was (service list read once when it opens, no
 * "Add a new service" button, no re-read before saving). Flip it in Dev Tools → Maintenance.
 *
 * Client-safe on purpose (no server imports): the dialog reads the stored value through GET /api/app-settings,
 * the same route the Maintenance panel uses, and this file decides what that reply means.
 */

export const ADD_SERVICE_KEY = 'offer_add_service_enabled' as const

/**
 * Is the switch on, given the reply of GET /api/app-settings?key=offer_add_service_enabled?
 * Only a successful reply carrying the boolean `true` counts. A string "true", the number 1, a missing value
 * (the route answers `{ value: null }` when no row exists) or an error page all mean OFF.
 */
export function parseAddServiceSwitch(ok: boolean, body: unknown): boolean {
  if (!ok || !body || typeof body !== 'object') return false
  return (body as { value?: unknown }).value === true
}
