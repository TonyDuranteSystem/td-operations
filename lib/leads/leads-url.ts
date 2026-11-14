/**
 * Where the Leads list lives (dev job a1839d8b, 14 Nov 2026 — Antonio: "the page Leads must live in the booking page").
 * The Leads list is now the "Leads" tab of the Booking page: `/booking?tab=leads&<the list's own parameters>`. The lead DETAIL page stays at `/leads/<id>`.
 * Pure, no I/O, client-safe: the redirect from the old `/leads` address, every button on the list that changes the address, and the tests all use these.
 *
 * The Booking page's own tab parameter is `tab`. None of the list's parameters is called `tab` (they are q, page, view, client, status, src, ref, offer, call,
 * follow, quick, and focus) — the list's own "Existing Clients" tab is the `client` parameter — so the two cannot collide. An OLD link that happens to carry a
 * `tab` is overridden, never obeyed: it always lands on the Leads tab.
 */

export const BOOKING_PATH = "/booking"
export const TAB_PARAM = "tab"
export type BookingTab = "leads" | "links"
export const DEFAULT_BOOKING_TAB: BookingTab = "leads"

type Params = Record<string, string | string[] | undefined>

/** Anything but an explicit "links" opens the Leads tab (Leads is the daily work, and an unknown value must never hide it). */
export function parseBookingTab(raw: string | string[] | undefined | null): BookingTab {
  const v = (Array.isArray(raw) ? raw[0] : raw) ?? ""
  return v.trim().toLowerCase() === "links" ? "links" : DEFAULT_BOOKING_TAB
}

function toSearchParams(input: URLSearchParams | Params | string | null | undefined): URLSearchParams {
  if (!input) return new URLSearchParams()
  if (typeof input === "string") return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
  if (input instanceof URLSearchParams) return new URLSearchParams(input.toString())
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const x of v) out.append(k, x)
    else out.append(k, v)
  }
  return out
}

/**
 * The address of the Leads tab carrying the list's parameters. Every parameter is kept (repeated ones too, in order); only `tab` is replaced.
 * Always a path on this site (never an absolute address), whatever the values say.
 */
export function leadsListHref(params?: URLSearchParams | Params | string | null): string {
  const incoming = toSearchParams(params)
  const out = new URLSearchParams()
  out.set(TAB_PARAM, "leads")
  incoming.forEach((value, key) => {
    if (key !== TAB_PARAM) out.append(key, value)
  })
  return `${BOOKING_PATH}?${out.toString()}`
}

/** The address of the Links and calls tab (optionally at the "Calls to check" section). */
export function linksTabHref(section?: "calls"): string {
  return `${BOOKING_PATH}?${TAB_PARAM}=links${section === "calls" ? "#calls" : ""}`
}
