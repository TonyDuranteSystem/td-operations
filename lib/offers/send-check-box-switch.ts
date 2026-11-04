/**
 * The switch for the box "Before this offer can be sent" beside the Send buttons (offer builder Part 1, dev job d2971d11).
 * OFF by default and fails CLOSED: a missing row, a failed read, or anything but a stored `true` means OFF, and OFF means no
 * box anywhere and no request to the check route: the offer screens are exactly what they always were. Antonio flips it in
 * Dev Tools → Maintenance when the whole offer builder is finished (his rule of 2026-11-04).
 *
 * Client-safe on purpose (no server imports): the box reads the stored value through GET /api/app-settings, the same route
 * the Maintenance panel and the Part 4 switch use, and this file decides what that reply means.
 */

export const SEND_CHECK_BOX_KEY = 'offer_send_check_box_enabled' as const

/** Only a successful reply carrying the boolean `true` counts: "true", 1, null (no row), an error page → OFF. */
export function parseSendCheckBoxSwitch(ok: boolean, body: unknown): boolean {
  if (!ok || !body || typeof body !== 'object') return false
  return (body as { value?: unknown }).value === true
}
