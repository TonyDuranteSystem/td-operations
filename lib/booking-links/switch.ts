/**
 * Booking page — the ONE switch: app_settings key `booking` = { "mode": "off" | "page" | "live" }.
 *   off   nothing happens (the missing / malformed / unreadable answer, always)
 *   page  the page and the redirect work; the Calendly webhook branch is SKIPPED (lets the app's own Calendly write proof run without arming the webhook)
 *   live  everything, including the webhook branch
 * The webhook branch also needs CALENDLY_WEBHOOK_SECRET: without it anyone could forge a booking and name a link, so the branch refuses to run.
 * Claude flips the setting on Antonio's word; he never gets a toggle. The reader takes the client as an argument (the webhook's own service client, or a fake in a test).
 */

export type BookingMode = "off" | "page" | "live"
export const BOOKING_SETTING_KEY = "booking"

export function parseBookingMode(raw: unknown): BookingMode {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).mode : raw
  return v === "live" || v === "page" ? v : "off"
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- app_settings read through whatever service client the caller holds
export async function readBookingMode(db: any): Promise<BookingMode> {
  try {
    const { data, error } = await db.from("app_settings").select("value").eq("key", BOOKING_SETTING_KEY).maybeSingle()
    return error ? "off" : parseBookingMode(data?.value)
  } catch {
    return "off"
  }
}

/** The webhook branch runs only in `live` mode AND with the signing secret configured. The secret is checked first: with it missing no database read is made at all. */
export async function webhookBranchEnabled(db: unknown, secret: string | undefined): Promise<boolean> {
  if (!secret) return false
  return (await readBookingMode(db)) === "live"
}
