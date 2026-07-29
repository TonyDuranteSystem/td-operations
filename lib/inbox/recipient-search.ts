/**
 * Recipient autocomplete for the Inbox email composer (Luca's request,
 * 2026-07-29; scope set by Antonio: ALL email addresses in the CRM plus the
 * Inbox correspondence history).
 *
 * Sources (each capped, queried in parallel):
 *  - contacts   — email, email_2, alt_emails[] (matched by name/either email;
 *                 alt addresses surface via their contact's name match)
 *  - members    — email + representative_email
 *  - partners   — email + secondary_email
 *  - leads      — email
 *  - accounts   — communication_email (labeled with the company name)
 *  - email_index— the Inbox's local message index (27k+ rows, no Gmail calls):
 *                 senders matched by name/address; recipients (to_emails[])
 *                 matched only when the query already looks like a full
 *                 address, because PostgREST has no partial match on arrays.
 *                 KNOWN RESIDUAL: someone we only ever WROTE to (never received
 *                 from) and never saved in the CRM won't match by name — a SQL
 *                 helper function (migration) is the fix if this bites.
 *
 * DELIBERATELY EXCLUDED: client_customers / client_vendors — those are our
 * clients' own correspondents (their businesses' books), not ours.
 *
 * Dedupe: one row per address (case-insensitive); a CRM identity always beats
 * an inbox-only sighting, so "Luca Gallacci — Contact" wins over a raw sender.
 */

export type RecipientSource = "contact" | "member" | "partner" | "lead" | "account" | "inbox"

export interface RecipientSuggestion {
  email: string
  /** Display name ("" when only the address is known). */
  name: string
  source: RecipientSource
  /** Company/account label when known. */
  company?: string
}

/** Lower = wins dedupe. CRM identities before inbox-only sightings. */
const SOURCE_RANK: Record<RecipientSource, number> = {
  contact: 1,
  member: 2,
  partner: 3,
  lead: 4,
  account: 5,
  inbox: 6,
}

export const MAX_RECIPIENT_SUGGESTIONS = 8

/** Cheap plausibility gate — an autocomplete row must be a sendable address. */
export function isEmailLike(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())
}

/**
 * Merge per-source suggestion lists into one ranked, deduped list.
 * Pure — unit-tested. Within a rank tier, first occurrence wins (sources are
 * passed in priority order and each source's own ordering is preserved).
 */
export function mergeRecipientSuggestions(
  lists: RecipientSuggestion[][],
  limit: number = MAX_RECIPIENT_SUGGESTIONS
): RecipientSuggestion[] {
  const byEmail = new Map<string, RecipientSuggestion>()
  for (const list of lists) {
    for (const s of list) {
      if (!isEmailLike(s.email)) continue
      const key = s.email.trim().toLowerCase()
      const existing = byEmail.get(key)
      if (!existing || SOURCE_RANK[s.source] < SOURCE_RANK[existing.source]) {
        // Keep the better identity, but never LOSE a name or company a
        // lower-ranked sighting carried (an inbox row often has the display
        // name an account row lacks).
        byEmail.set(key, {
          ...s,
          email: s.email.trim(),
          name: s.name || existing?.name || "",
          company: s.company || existing?.company,
        })
      } else if (existing) {
        if (!existing.name && s.name) existing.name = s.name
        if (!existing.company && s.company) existing.company = s.company
      }
    }
  }
  return Array.from(byEmail.values())
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
    .slice(0, limit)
}

/** Escape a user-typed term for a PostgREST .or(...) ilike pattern: commas and
 * parens are the .or() syntax itself; % and _ are LIKE wildcards; * is
 * PostgREST's own wildcard alias; a raw backslash must be doubled FIRST or a
 * trailing one eats the closing wildcard. */
export function escapeIlikeTerm(q: string): string {
  return q
    .replace(/\\/g, "\\\\")
    .replace(/[,()*]/g, " ")
    .replace(/[%_]/g, "\\$&")
    .trim()
}

/**
 * Query all sources in parallel and merge. Server-only (service-role client);
 * caller must have passed the staff gate. Query is expected pre-trimmed, ≥2
 * chars. Every per-source failure degrades to an empty list — autocomplete
 * must never 500 the composer.
 *
 * `includePersonalMailbox` MUST reflect the caller's admin-ness: email_index
 * rows for antonio@ are ADMIN-ONLY (RLS in the 2026-07-09 migration; the
 * service-role client bypasses it, so this filter is the boundary). A
 * non-admin search is scoped to the shared support mailbox — otherwise
 * antonio@'s personal correspondents would be name-enumerable by any staff
 * login (council blocker 2026-07-29).
 */
export async function searchRecipients(
  q: string,
  opts: { includePersonalMailbox?: boolean } = {}
): Promise<RecipientSuggestion[]> {
  const includePersonal = opts.includePersonalMailbox === true
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // email_index is not in the generated DB types — same cast pattern as
  // email_snoozes (a types resync is a known prod-build hazard).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const untypedDb = supabaseAdmin as any
  const term = escapeIlikeTerm(q)
  if (term.length < 2) return []
  const pattern = `%${term}%`
  const PER_SOURCE = 10

  const safe = async <T>(p: PromiseLike<{ data: T[] | null }>): Promise<T[]> => {
    try {
      return (await p).data ?? []
    } catch {
      return []
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const [contacts, members, partners, leads, accounts, senders, sentTo] = await Promise.all([
    safe<any>(
      supabaseAdmin
        .from("contacts")
        .select("full_name, email, email_2, alt_emails, account_contacts(accounts(company_name))")
        .or(`full_name.ilike.${pattern},email.ilike.${pattern},email_2.ilike.${pattern}`)
        .limit(PER_SOURCE)
    ),
    safe<any>(
      supabaseAdmin
        .from("members")
        .select("full_name, email, representative_email")
        .or(`full_name.ilike.${pattern},email.ilike.${pattern},representative_email.ilike.${pattern}`)
        .limit(PER_SOURCE)
    ),
    safe<any>(
      supabaseAdmin
        .from("partners")
        .select("partner_name, company, email, secondary_email")
        .or(`partner_name.ilike.${pattern},email.ilike.${pattern},secondary_email.ilike.${pattern}`)
        .limit(PER_SOURCE)
    ),
    safe<any>(
      supabaseAdmin
        .from("leads")
        .select("full_name, email")
        .not("email", "is", null)
        .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
        .limit(PER_SOURCE)
    ),
    safe<any>(
      supabaseAdmin
        .from("accounts")
        .select("company_name, communication_email")
        .not("communication_email", "is", null)
        .or(`company_name.ilike.${pattern},communication_email.ilike.${pattern}`)
        .limit(PER_SOURCE)
    ),
    safe<any>(
      (() => {
        let sendersQuery = untypedDb
          .from("email_index")
          .select("from_email, from_name")
          .or(`from_email.ilike.${pattern},from_name.ilike.${pattern}`)
        if (!includePersonal) sendersQuery = sendersQuery.eq("mailbox", "support")
        return sendersQuery.order("internal_date", { ascending: false }).limit(60)
      })()
    ),
    // Array columns have no partial match in PostgREST — exact membership
    // only, so this source fires only for a fully-typed address.
    isEmailLike(q)
      ? safe<any>(
          (() => {
            let sentToQuery = untypedDb
              .from("email_index")
              .select("to_emails")
              .contains("to_emails", [q.trim().toLowerCase()])
            if (!includePersonal) sentToQuery = sentToQuery.eq("mailbox", "support")
            return sentToQuery.limit(1)
          })()
        )
      : Promise.resolve([] as any[]),
  ])
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const contactRows: RecipientSuggestion[] = []
  for (const c of contacts) {
    const company = c.account_contacts?.[0]?.accounts?.company_name ?? undefined
    for (const email of [c.email, c.email_2, ...(Array.isArray(c.alt_emails) ? c.alt_emails : [])]) {
      if (email) contactRows.push({ email, name: c.full_name ?? "", source: "contact", company })
    }
  }

  const memberRows: RecipientSuggestion[] = members.flatMap((m: { full_name?: string; email?: string; representative_email?: string }) =>
    [m.email, m.representative_email]
      .filter(Boolean)
      .map((email) => ({ email: email as string, name: m.full_name ?? "", source: "member" as const }))
  )

  const partnerRows: RecipientSuggestion[] = partners.flatMap((p: { partner_name?: string; company?: string; email?: string; secondary_email?: string }) =>
    [p.email, p.secondary_email]
      .filter(Boolean)
      .map((email) => ({ email: email as string, name: p.partner_name ?? "", source: "partner" as const, company: p.company ?? undefined }))
  )

  const leadRows: RecipientSuggestion[] = leads
    .filter((l: { email?: string }) => l.email)
    .map((l: { full_name?: string; email: string }) => ({ email: l.email, name: l.full_name ?? "", source: "lead" as const }))

  const accountRows: RecipientSuggestion[] = accounts.map(
    (a: { company_name?: string; communication_email: string }) => ({
      email: a.communication_email,
      name: a.company_name ?? "",
      source: "account" as const,
      company: a.company_name ?? undefined,
    })
  )

  // Dedupe senders before merging — a chatty correspondent's messages would
  // otherwise occupy the whole row budget and starve other matching senders
  // (hence the 60-row fetch: distinct-on isn't available through PostgREST).
  const seenSenders = new Set<string>()
  const inboxRows: RecipientSuggestion[] = []
  for (const s of senders as Array<{ from_email?: string; from_name?: string }>) {
    const key = (s.from_email ?? "").toLowerCase()
    if (!key || seenSenders.has(key)) continue
    seenSenders.add(key)
    inboxRows.push({ email: s.from_email ?? "", name: s.from_name ?? "", source: "inbox" })
  }
  if (sentTo.length > 0 && isEmailLike(q)) {
    inboxRows.push({ email: q.trim(), name: "", source: "inbox" })
  }

  return mergeRecipientSuggestions([
    contactRows,
    memberRows,
    partnerRows,
    leadRows,
    accountRows,
    inboxRows,
  ])
}
