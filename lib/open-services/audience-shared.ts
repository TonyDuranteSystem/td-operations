/**
 * Open services tab — who may see it (N1a C3, dev job be7da01a).
 *
 * PURE and client-safe: no server imports. The Maintenance panel (browser code) and the server both use it.
 *
 * The setting `open_services_audience` has exactly three values. ANYTHING else (a typo, `true`, an object, null, a
 * missing row) means 'off', so a bad value can never open the page to more people than intended.
 */

export const AUDIENCES = ["off", "owners", "all"] as const
export type Audience = (typeof AUDIENCES)[number]

export const AUDIENCE_LABELS: Record<Audience, string> = {
  off: "Off",
  owners: "Owners only",
  all: "All staff",
}

/** The canonical value for an input that is exactly one of the three (trim + lowercase), else null. */
export function strictAudienceOrNull(raw: unknown): Audience | null {
  if (typeof raw !== "string") return null
  const v = raw.trim().toLowerCase()
  return (AUDIENCES as readonly string[]).includes(v) ? (v as Audience) : null
}

/** Reads the stored setting. Fails CLOSED: anything that is not one of the three values is 'off'. */
export function parseAudience(raw: unknown): Audience {
  return strictAudienceOrNull(raw) ?? "off"
}
