/**
 * Booking page — the public address a link is sent as: <app address>/r/b/<id>. Decides where the visitor goes. NO login, so it is built to give nothing away:
 * the visitor is only ever sent to a plain https://calendly.com/... address, and the page says nothing about whether an id exists.
 *
 *   - the link is looked up by its random id, and only an id of our exact 22-character shape is looked up at all
 *   - found: the visitor goes to Calendly with the link's id added as the tag the webhook reads back (utm_term) and, if the link knows them, their name and email filled in
 *       a link with its own length goes to the one-time Calendly address stored when it was made; the standard 30-minute link goes to the booking page named in
 *       app_settings.booking_templates AT CLICK TIME (so a renamed page keeps working)
 *   - unknown, malformed, revoked or expired id, the switch OFF, a missing table, a template that is gone: the visitor goes to the normal public booking page with NO tag,
 *     exactly as before this page existed (so a dead link never strands a client)
 *   - the one exception: a lookup that FAILS (database down) answers "try again" instead of quietly dropping the tag — a booking without its tag would become a stray lead
 *   - a used (claimed) link still goes to Calendly: the engine decides what to do with a second booking; for a one-time Calendly address Calendly itself says it is used
 */

import { CALENDLY_BOOKING_URL } from "@/lib/config"
import { isStrictLinkId } from "@/lib/booking-links/id"
import { findLinkByPublicId } from "@/lib/booking-links/store"
import { readBookingMode } from "@/lib/booking-links/switch"
import { buildDestination } from "@/lib/booking-links/destination"
import { isMissingTable } from "@/lib/booking-links/missing-table"
import { loadTemplates, templateFor } from "@/lib/booking/templates"
import { linkStatusOf } from "@/lib/booking/links"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

export type RedirectDecision = { kind: "redirect"; location: string; tagged: boolean } | { kind: "retry" }

/** Preview robots (chat apps unfurling a pasted link) must not count as people opening it. */
export function looksLikeBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true
  return /bot|crawl|spider|preview|slurp|facebookexternalhit|whatsapp|telegram|skype|linkedin|embedly|quora|pinterest|vkshare|W3C_Validator|headless|curl|wget|python-requests|node-fetch|axios|go-http/i.test(userAgent)
}

export async function decideRedirect(db: Db, rawId: unknown, opts: { now: Date; fallbackUrl?: string; userAgent?: string | null }): Promise<RedirectDecision> {
  const plain: RedirectDecision = { kind: "redirect", location: opts.fallbackUrl ?? CALENDLY_BOOKING_URL, tagged: false }

  if ((await readBookingMode(db)) === "off") return plain
  if (!isStrictLinkId(rawId)) return plain

  const found = await findLinkByPublicId(db, rawId)
  if (found.state === "none") return plain
  if (found.state === "error") return { kind: "retry" }
  const row = found.row

  const status = linkStatusOf(row, opts.now)
  if (status === "revoked" || status === "expired") return plain

  let stored: string | null = null
  try {
    const { data, error } = await db.from("booking_links").select("share_url, template_slug, person_name, person_emails").eq("id", row.id).maybeSingle()
    if (error) return isMissingTable(error) ? plain : { kind: "retry" }
    if (!data) return plain
    let base: string | null = typeof data.share_url === "string" && data.share_url ? data.share_url : null
    if (!base) {
      const role = data.template_slug === "sales" ? "sales" : data.template_slug === "plain" ? "plain" : null
      base = role ? templateFor(await loadTemplates(db), role)?.schedulingUrl ?? null : null
    }
    const email = Array.isArray(data.person_emails) && data.person_emails.length ? String(data.person_emails[0]) : null
    stored = base ? buildDestination(base, { linkId: row.public_id, name: (data.person_name as string | null) ?? null, email }) : null
  } catch {
    return { kind: "retry" }
  }
  if (!stored) return plain

  // best effort, never blocks the visitor: count the visit (not preview robots)
  if (!looksLikeBot(opts.userAgent)) {
    try {
      const { data: cur } = await db.from("booking_links").select("open_count").eq("id", row.id).maybeSingle()
      const n = typeof cur?.open_count === "number" ? cur.open_count : 0
      await db.from("booking_links").update({ open_count: n + 1, last_opened_at: opts.now.toISOString() }).eq("id", row.id).eq("open_count", n)
    } catch {
      /* the count is informational */
    }
  }
  return { kind: "redirect", location: stored, tagged: true }
}
