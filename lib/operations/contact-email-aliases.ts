/**
 * ONE alias-aware way to ask "is this email a known contact?" — used by the booking link maker (link-time check) and the Calendly webhook (the same answer both times).
 *
 * Why a new helper: the existing findContactIdByEmail (lib/operations/find-contact-by-email.ts) checks `email` and `alt_emails` but NOT `email_2`, and discards database errors; the
 * Calendly webhook's own lookup checks `email` only. A client who books with their second address would read as a stranger. This one checks all three columns, ignores merged
 * tombstones, prefers the oldest contact, and reports a database error instead of hiding it. The client is passed in (service client, or a fake in a test).
 */

export interface AliasContact {
  id: string
  full_name: string | null
  email: string | null
  email_2: string | null
  alt_emails: string[] | null
  portal_tier: string | null
  created_at: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

const COLUMNS = "id, full_name, email, email_2, alt_emails, portal_tier, created_at"

const lower = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "")

/** `_` and `%` are wildcards in ILIKE: a real address like a_b@x.com must match only itself. */
export function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1")
}

/** Every address this contact is known by, lowercased, without duplicates or blanks. This is what a link snapshots as person_emails. */
export function contactEmailSet(c: Pick<AliasContact, "email" | "email_2" | "alt_emails">): string[] {
  const all = [c.email, c.email_2, ...(Array.isArray(c.alt_emails) ? c.alt_emails : [])].map(lower).filter(Boolean)
  return Array.from(new Set(all))
}

export function contactHasEmail(c: Pick<AliasContact, "email" | "email_2" | "alt_emails">, email: string): boolean {
  const e = lower(email)
  return e !== "" && contactEmailSet(c).includes(e)
}

export type AliasLookup = { state: "found"; contact: AliasContact; others: number } | { state: "none" } | { state: "error"; message: string }

export async function findContactByAnyEmail(db: Db, email: string): Promise<AliasLookup> {
  const e = lower(email)
  if (!e) return { state: "none" }
  try {
    const pattern = escapeLike(e)
    const [byEmail, byEmail2, byAlt] = await Promise.all([
      db.from("contacts").select(COLUMNS).is("merged_into", null).ilike("email", pattern).order("created_at", { ascending: true }).limit(25),
      db.from("contacts").select(COLUMNS).is("merged_into", null).ilike("email_2", pattern).order("created_at", { ascending: true }).limit(25),
      db.from("contacts").select(COLUMNS).is("merged_into", null).contains("alt_emails", [e]).order("created_at", { ascending: true }).limit(25),
    ])
    const failed = [byEmail, byEmail2, byAlt].find((r) => r.error)
    if (failed) return { state: "error", message: String(failed.error.message ?? "lookup failed") }
    const seen = new Map<string, AliasContact>()
    for (const r of [byEmail, byEmail2, byAlt]) {
      for (const c of (r.data ?? []) as AliasContact[]) if (contactHasEmail(c, e) && !seen.has(c.id)) seen.set(c.id, c)
    }
    const list = Array.from(seen.values()).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    if (list.length === 0) return { state: "none" }
    return { state: "found", contact: list[0], others: list.length - 1 }
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) }
  }
}
