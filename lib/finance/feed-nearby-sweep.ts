/**
 * The "around the payment date" half of the Bank Feed investigator's guaranteed looks.
 *
 * Antonio, 2026-10-30, on a €3,000 Stripe payment from a payer nobody had recorded: "check if there is any
 * connection with this payment in that period — calls as leads, companies created or onboarded between 13 and
 * 20 February. If those are already connected with other payments or other people, avoid them and see what is
 * left." The AI had searched only by the payer's NAME; nothing made it look at what else was happening that week.
 *
 * What it reads, around the payment date (14 days before, 7 days after):
 *  - companies that STARTED then — became a client, were onboarded, or were formed;
 *  - leads that had a CALL then;
 *  - offers dated then.
 * and SETS ASIDE every one that is already tied to another payment: by the company, by its people (and the other
 * companies those people own), or by another bank line. What is left is a list of leads to check — never proof.
 *
 * DATES: the CRM's own `created_at` cannot be used for early 2026. The first company was created on 2026-02-22
 * and 275 of 351 before March: that is the move from the old system, not when the client arrived. The real dates
 * are the ones used here (client_since / onboarding_date / formation_date, offer_date, call_date).
 *
 * What counts as "already tied to a payment": a payment of theirs that is genuinely PAID (money received, not a
 * credit note and not a cancelled one) with a paid date in the window plus 30 days after it, OR a payment of
 * theirs that ANOTHER matched bank line points at in that same stretch. Everything set aside is named, with the
 * reason, so what was dropped can be checked.
 *
 * Read-only. NEVER throws: a list that cannot be read is named in `error`, never reported as "nothing found".
 * The names are text written by third parties: the caller puts them in the prompt as untrusted data.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { cleanText } from "@/lib/finance/feed-investigation"
import { isPaidInvoice } from "@/lib/finance/invoice-matchability"
import { readLinkedPaymentIds } from "@/lib/finance/multi-invoice-link"

export const NEARBY_DAYS_BEFORE = 14
export const NEARBY_DAYS_AFTER = 7
/** A payment this many days after the window still counts as "already paid for" when setting a candidate aside. */
export const SET_ASIDE_DAYS_AFTER = 30
/** Rows read per list, and how many of each kind are kept for the prompt. */
export const MAX_FETCH = 60
export const MAX_LISTED_LEFT = 25
export const MAX_LISTED_ASIDE = 15
const ID_CHUNK = 50
const MAX_BANK_LINES = 500

export type NearbyKind = "company" | "call" | "offer"

export interface NearbyItem {
  kind: NearbyKind
  id: string
  name: string
  /** Plain words: "onboarded 2026-02-16", "call on 2026-02-16 (lead: Offer Sent)", "offer dated 2026-02-12 (signed)". */
  what: string
  /** The date the item is placed at, YYYY-MM-DD. */
  date: string
  /** The record's own status word, when it has one. */
  status: string | null
  /** null = still unaccounted for; otherwise the reason it was set aside. */
  setAside: string | null
}

export interface NearbyTotals {
  companies: number
  calls: number
  offers: number
  set_aside: number
  left: number
}

export interface NearbySweep {
  /** True when at least one list could be read. */
  ran: boolean
  /** The look window, YYYY-MM-DD; null when the payment has no usable date. */
  window: { from: string; to: string } | null
  /** Payments up to this date count as "already paid for". */
  paidThrough: string | null
  /** Capped: the first MAX_LISTED_LEFT unaccounted ones and the first MAX_LISTED_ASIDE set aside. */
  items: NearbyItem[]
  /** Full counts, before the cap. */
  totals: NearbyTotals
  /** What could not be read, in plain words; null when everything ran. */
  error: string | null
}

/** What is kept on the payment: counts, never the names. */
export interface NearbySummary extends NearbyTotals {
  ran: boolean
  window: { from: string; to: string } | null
  error: string | null
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Pure parts
// ───────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)

/** `before` days before and `after` days after a YYYY-MM-DD date; null when the date is missing or not a date. */
export function windowAround(date: string | null | undefined, before: number, after: number): { from: string; to: string } | null {
  const text = String(date ?? "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const t = Date.parse(`${text}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return { from: new Date(t - before * DAY_MS).toISOString().slice(0, 10), to: new Date(t + after * DAY_MS).toISOString().slice(0, 10) }
}

/** `day` plus `n` days (YYYY-MM-DD in, YYYY-MM-DD out). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** What goes on the payment: the counts. */
export function summarizeNearby(sweep: NearbySweep): NearbySummary {
  return { ran: sweep.ran, window: sweep.window, error: sweep.error, ...sweep.totals }
}

const EMPTY_TOTALS: NearbyTotals = { companies: 0, calls: 0, offers: 0, set_aside: 0, left: 0 }

/** A look that did not run at all: every count is zero and `error` says why. */
export function nearbyNotRun(reason: string): NearbySweep {
  return { ran: false, window: null, paidThrough: null, items: [], totals: { ...EMPTY_TOTALS }, error: reason }
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Reading the database
// ───────────────────────────────────────────────────────────────────────────────────────

type Db = typeof supabaseAdmin
interface QueryResult { data: unknown; error: { message: string } | null }
type Row = Record<string, unknown>

const rowsOf = (r: QueryResult): Row[] => (Array.isArray(r.data) ? (r.data as Row[]) : [])
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const uniq = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)))

async function read(run: () => PromiseLike<QueryResult>): Promise<QueryResult> {
  try {
    return await run()
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
  }
}

/** One read per chunk of ids (a long list in the address would be refused); rows merged, the first error kept. */
async function readIn(ids: string[], run: (chunk: string[]) => PromiseLike<QueryResult>): Promise<QueryResult> {
  if (ids.length === 0) return { data: [], error: null }
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK))
  const results = await Promise.all(chunks.map((c) => read(() => run(c))))
  const failed = results.find((r) => r.error)
  if (failed) return { data: null, error: failed.error }
  return { data: results.flatMap(rowsOf), error: null }
}

interface NearbyInput {
  facts: { transaction_date?: string | null }
  /** This payment's own bank line: it is never counted as "another bank line". */
  feedId: string
  db?: Db
}

/** The first of these dates that falls inside the window, as plain words. */
function startedWhen(row: Row, window: { from: string; to: string }): { what: string; date: string } | null {
  const candidates: Array<[unknown, string]> = [
    [row.client_since, "became a client"],
    [row.onboarding_date, "onboarded"],
    [row.formation_date, "formed"],
  ]
  for (const [value, words] of candidates) {
    if (isDay(value)) {
      const d = value.slice(0, 10)
      if (d >= window.from && d <= window.to) return { what: `${words} ${d}`, date: d }
    }
  }
  return null
}

/**
 * Look around the payment date. NEVER throws: a list that fails is named in `error`, and the others still answer.
 */
export async function runNearbySweep(input: NearbyInput): Promise<NearbySweep> {
  const db = input.db ?? supabaseAdmin
  const look = windowAround(input.facts.transaction_date, NEARBY_DAYS_BEFORE, NEARBY_DAYS_AFTER)
  if (!look) return nearbyNotRun("the payment has no usable date")
  const paidThrough = addDays(look.to, SET_ASIDE_DAYS_AFTER)
  const errors: string[] = []
  const take = (what: string, r: QueryResult): Row[] => {
    if (r.error) {
      errors.push(`${what}: ${cleanText(r.error.message, 120)}`)
      return []
    }
    return rowsOf(r)
  }

  // 1. What started, was called or was offered around the date.
  const inWindow = (column: string) => `and(${column}.gte.${look.from},${column}.lte.${look.to})`
  const [companiesRes, leadsRes, offersRes] = await Promise.all([
    read(() => db.from("accounts").select("id, company_name, status, client_since, onboarding_date, formation_date").or(["client_since", "onboarding_date", "formation_date"].map(inWindow).join(",")).limit(MAX_FETCH) as unknown as PromiseLike<QueryResult>),
    read(() => db.from("leads").select("id, full_name, status, call_date, converted_to_contact_id").gte("call_date", look.from).lte("call_date", look.to).limit(MAX_FETCH) as unknown as PromiseLike<QueryResult>),
    read(() => db.from("offers").select("id, client_name, status, offer_date, lead_id, contact_id, account_id").gte("offer_date", look.from).lte("offer_date", look.to).limit(MAX_FETCH) as unknown as PromiseLike<QueryResult>),
  ])
  const failedLists = [companiesRes, leadsRes, offersRes].filter((r) => r.error).length
  const companies = take("companies", companiesRes)
  const leads = take("calls", leadsRes)
  const offers = take("offers", offersRes)
  if (failedLists === 3) return { ...nearbyNotRun(errors.join("; ")), window: look, paidThrough }

  // 2. The people behind them, and every other company those people own.
  const accountIds = uniq([...companies.map((r) => str(r.id)), ...offers.map((r) => str(r.account_id))])
  const directContactIds = uniq([...leads.map((r) => str(r.converted_to_contact_id)), ...offers.map((r) => str(r.contact_id))])
  const owners = take("the people of those companies", await readIn(accountIds, (ids) => db.from("account_contacts").select("account_id, contact_id").in("account_id", ids).is("ended_at", null) as unknown as PromiseLike<QueryResult>))
  const contactIds = uniq([...directContactIds, ...owners.map((r) => str(r.contact_id))])
  const theirCompanies = take("the other companies of those people", await readIn(contactIds, (ids) => db.from("account_contacts").select("account_id, contact_id").in("contact_id", ids).is("ended_at", null) as unknown as PromiseLike<QueryResult>))
  const allAccountIds = uniq([...accountIds, ...theirCompanies.map((r) => str(r.account_id))])

  // 3. Their payments, and the payments that other bank lines point at, in the same stretch.
  const paymentColumns = "id, account_id, contact_id, status, invoice_status, amount, amount_currency, paid_date, invoice_number"
  const [byAccount, byContact, feedsRes] = await Promise.all([
    readIn(allAccountIds, (ids) => db.from("payments").select(paymentColumns).in("account_id", ids).gte("paid_date", look.from).lte("paid_date", paidThrough).not("is_test", "is", true) as unknown as PromiseLike<QueryResult>),
    readIn(contactIds, (ids) => db.from("payments").select(paymentColumns).in("contact_id", ids).gte("paid_date", look.from).lte("paid_date", paidThrough).not("is_test", "is", true) as unknown as PromiseLike<QueryResult>),
    read(() => db.from("td_bank_feeds").select("id, matched_payment_id, review_metadata").eq("status", "matched").neq("id", input.feedId).gte("transaction_date", look.from).lte("transaction_date", paidThrough).limit(MAX_BANK_LINES) as unknown as PromiseLike<QueryResult>),
  ])
  const paidRows = [...take("their payments", byAccount), ...take("their payments", byContact)]
  const feeds = take("other bank lines", feedsRes)
  const linkedIds = uniq(feeds.flatMap((f) => [str(f.matched_payment_id), ...readLinkedPaymentIds(f.review_metadata)]))
  const linkedRows = take("the payments other bank lines point at", await readIn(linkedIds, (ids) => db.from("payments").select(paymentColumns).in("id", ids) as unknown as PromiseLike<QueryResult>))

  // 4. Who is already accounted for, and why.
  const byAccountReason = new Map<string, string>()
  const byContactReason = new Map<string, string>()
  const money = (r: Row) => `${Number(r.amount)} ${str(r.amount_currency)}`.trim()
  const remember = (r: Row, reason: string) => {
    const a = str(r.account_id)
    const c = str(r.contact_id)
    if (a && !byAccountReason.has(a)) byAccountReason.set(a, reason)
    if (c && !byContactReason.has(c)) byContactReason.set(c, reason)
  }
  const seenPaid = new Set<string>()
  for (const r of paidRows) {
    const id = str(r.id)
    if (!id || seenPaid.has(id)) continue
    seenPaid.add(id)
    // Money RECEIVED only: a credit note is "Paid" too, but it is a negative amount — money paid OUT.
    if (!isPaidInvoice({ invoice_status: str(r.invoice_status) || null, status: str(r.status) || null }) || !(Number(r.amount) > 0)) continue
    remember(r, `${money(r)} paid on ${str(r.paid_date).slice(0, 10)}${str(r.invoice_number) ? ` (${str(r.invoice_number)})` : ""}`)
  }
  for (const r of linkedRows) {
    if (!(Number(r.amount) > 0)) continue
    remember(r, `another bank line is tied to their payment${str(r.invoice_number) ? ` ${str(r.invoice_number)}` : ""} (${money(r)})`)
  }

  const ownersOf = (accountId: string) => owners.filter((r) => str(r.account_id) === accountId).map((r) => str(r.contact_id))
  const companiesOf = (contactId: string) => theirCompanies.filter((r) => str(r.contact_id) === contactId).map((r) => str(r.account_id))
  const accountedByPerson = (contactId: string): string | null => {
    if (!contactId) return null
    const own = byContactReason.get(contactId)
    if (own) return own
    for (const other of companiesOf(contactId)) {
      const reason = byAccountReason.get(other)
      if (reason) return `${reason}, on another company of the same person`
    }
    return null
  }
  const accountedByCompany = (accountId: string): string | null => {
    if (!accountId) return null
    const own = byAccountReason.get(accountId)
    if (own) return own
    for (const owner of ownersOf(accountId)) {
      const reason = accountedByPerson(owner)
      if (reason) return `${reason}, through its owner`
    }
    return null
  }

  // 5. The items.
  const items: NearbyItem[] = []
  for (const r of companies) {
    const started = startedWhen(r, look)
    const id = str(r.id)
    if (!id || !started) continue
    items.push({ kind: "company", id, name: cleanText(r.company_name, 120) || "a company", what: started.what, date: started.date, status: str(r.status) || null, setAside: accountedByCompany(id) })
  }
  for (const r of leads) {
    const id = str(r.id)
    const date = isDay(r.call_date) ? r.call_date.slice(0, 10) : ""
    if (!id || !date) continue
    items.push({ kind: "call", id, name: cleanText(r.full_name, 120) || "a lead", what: `call on ${date} (lead: ${str(r.status) || "no status"})`, date, status: str(r.status) || null, setAside: accountedByPerson(str(r.converted_to_contact_id)) })
  }
  for (const r of offers) {
    const id = str(r.id)
    const date = isDay(r.offer_date) ? r.offer_date.slice(0, 10) : ""
    if (!id || !date) continue
    items.push({ kind: "offer", id, name: cleanText(r.client_name, 120) || "an offer", what: `offer dated ${date} (${str(r.status) || "no status"})`, date, status: str(r.status) || null, setAside: accountedByCompany(str(r.account_id)) ?? accountedByPerson(str(r.contact_id)) })
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)))

  const left = items.filter((i) => !i.setAside)
  const aside = items.filter((i) => i.setAside)
  return {
    ran: true,
    window: look,
    paidThrough,
    items: [...left.slice(0, MAX_LISTED_LEFT), ...aside.slice(0, MAX_LISTED_ASIDE)],
    totals: {
      companies: items.filter((i) => i.kind === "company").length,
      calls: items.filter((i) => i.kind === "call").length,
      offers: items.filter((i) => i.kind === "offer").length,
      set_aside: aside.length,
      left: left.length,
    },
    error: errors.length ? errors.join("; ") : null,
  }
}
