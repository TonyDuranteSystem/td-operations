/**
 * The invoices the Bank Feed's "Match to invoice" popup should put in front of a person for ONE
 * transaction: the ones belonging to the company (or person) this payer has been linked to
 * before — paid AND unpaid, with the paid date — plus any set of them that adds up to the
 * payment exactly. See lib/finance/payer-suggestions.ts for the rules; this file only reads the
 * data and hands it to them.
 *
 * Nothing here changes any record. It never hides an invoice from the popup either: the plain
 * list of every unpaid invoice stays where it was; this is the part ABOVE it.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isPaidInvoice, isTerminalInvoice } from "@/lib/finance/invoice-matchability"
import { readClaimedInvoiceIds } from "@/lib/finance/claimed-invoices"
import { extractFeedEmails } from "@/lib/finance/feed-signals"
import { isProcessorOnlyDescriptor } from "@/lib/finance/payer-learning-rules"
import {
  escapeLikePattern,
  findExactCombos,
  isUsablePayerName,
  normalizePayerName,
  parsePayerEmail,
  rankPayerCompanies,
  type ExactCombo,
  type PayerHistoryRow,
} from "@/lib/finance/payer-suggestions"

/** How many earlier transactions from the same sender are read to work out their companies. */
const HISTORY_LIMIT = 300
/** How many invoices are returned per kind of owner (company / person). */
const INVOICE_LIMIT = 120
/** At most this many companies/people are offered for one payment. */
const MAX_COMPANIES = 5
/** How many exact-sum sets are offered across both kinds. */
const MAX_COMBOS_OFFERED = 5

export interface PayerInvoice {
  id: string
  invoice_number: string | null
  description: string | null
  installment: string | null
  total: number | null
  /** What is still owed (unpaid invoices); null for a paid one. */
  balance: number | null
  currency: string | null
  paid: boolean
  paid_date: string | null
  /** The invoice's own status word when it is not Paid (Draft, Sent, Overdue, Partial, ...). */
  status_label: string | null
  account_id: string | null
  contact_id: string | null
  /** The company or person the invoice belongs to. */
  party: string
  /** Already tied to a DIFFERENT bank transaction — shown as such, never suggested. */
  claimed_by_other: boolean
}

export interface PayerCompanyInfo {
  kind: "account" | "contact"
  id: string
  name: string
  /**
   * Why this company is offered: `email` = the billing email on this payment belongs to one of its
   * contacts in the CRM (the strongest signal); `history` = earlier payments from this same sender
   * were linked to it; `search` = the person searched for it.
   */
  source: "email" | "history" | "search"
  /** For `history`: how many earlier payments from this sender were linked here. */
  times_linked: number
  last_linked: string | null
}

export interface PayerInvoicesResult {
  ok: boolean
  error?: string
  payer?: { name: string | null; email: string | null }
  companies?: PayerCompanyInfo[]
  invoices?: PayerInvoice[]
  combos?: ExactCombo[]
  /** True when a list hit its ceiling — the rest is still reachable by searching. */
  truncated?: boolean
}

interface FeedForSuggestions {
  id: string
  sender_name: string | null
  sender_reference?: string | null
  raw_data?: unknown
  memo: string | null
  amount: number | string
  currency: string | null
  transaction_date: string | null
  status: string | null
  owner_account_number?: string | null
}

type RawInvoice = {
  id: string
  invoice_number: string | null
  description: string | null
  installment: string | null
  total: number | string | null
  amount: number | string | null
  amount_due: number | string | null
  amount_paid: number | string | null
  amount_currency: string | null
  invoice_status: string | null
  status: string | null
  paid_date: string | null
  account_id: string | null
  contact_id: string | null
  is_test: boolean | null
  accounts?: { company_name: string | null } | { company_name: string | null }[] | null
  contacts?: { full_name: string | null } | { full_name: string | null }[] | null
}

const INVOICE_COLUMNS =
  "id, invoice_number, description, installment, total, amount, amount_due, amount_paid, amount_currency, invoice_status, status, paid_date, account_id, contact_id, is_test, accounts:account_id(company_name), contacts:payments_contact_id_fkey(full_name)"

const num = (v: number | string | null | undefined): number | null => {
  if (v == null) return null
  const n = typeof v === "string" ? parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}
const first = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

/** An invoice a payment can still be tied to: paid, or genuinely owed. Voided/cancelled/credit/split/refunded are not. */
function isLinkableForSuggestion(inv: RawInvoice): boolean {
  if (inv.is_test === true) return false
  // Money returned to the client is not a payment to link to, even when the invoice still reads Paid.
  if (String(inv.status ?? "") === "Refunded") return false
  if (isPaidInvoice(inv)) return true
  if (isTerminalInvoice(inv)) return false
  return String(inv.status ?? "") !== "Refunded"
}

export function toPayerInvoice(inv: RawInvoice, claimed: Set<string>): PayerInvoice {
  const paid = isPaidInvoice(inv)
  const total = num(inv.total) ?? num(inv.amount)
  // What is still owed: the invoice total less what was actually received — the same arithmetic the
  // payment waterfall uses (the `amount_due` column was not kept up to date by older writers).
  const balance = paid ? null : (total != null ? Math.max(total - (num(inv.amount_paid) ?? 0), 0) : null)
  const company = first(inv.accounts)?.company_name ?? null
  const person = first(inv.contacts)?.full_name ?? null
  return {
    id: inv.id,
    invoice_number: inv.invoice_number,
    description: inv.description?.trim() || null,
    installment: inv.installment?.trim() || null,
    total,
    balance,
    currency: inv.amount_currency,
    paid,
    paid_date: inv.paid_date ? String(inv.paid_date).slice(0, 10) : null,
    status_label: paid ? null : (inv.invoice_status?.trim() || inv.status?.trim() || null),
    account_id: inv.account_id,
    contact_id: inv.contact_id,
    party: company ?? person ?? "—",
    claimed_by_other: claimed.has(inv.id),
  }
}

/**
 * Who the billing email on this payment belongs to, in the CRM — the same lookup the automatic
 * matcher uses (email → contact → the companies that contact belongs to). Case-insensitive,
 * exact (wildcards escaped). Null when it could not be read.
 */
async function readEmailIdentity(feed: FeedForSuggestions): Promise<{ accountIds: string[]; contactIds: string[] } | null> {
  const emails = extractFeedEmails(feed).slice(0, 5)
  if (emails.length === 0) return { accountIds: [], contactIds: [] }

  const lookups = await Promise.all(
    emails.map((e) => supabaseAdmin.from("contacts").select("id").ilike("email", escapeLikePattern(e)).limit(20)),
  )
  if (lookups.some((r) => r.error)) return null
  const contactIds = Array.from(new Set(lookups.flatMap((r) => (r.data ?? []).map((c) => c.id))))
  if (contactIds.length === 0) return { accountIds: [], contactIds: [] }

  const links = await supabaseAdmin.from("account_contacts").select("account_id").in("contact_id", contactIds)
  if (links.error) return null
  const accountIds = Array.from(new Set((links.data ?? []).map((l) => l.account_id).filter((id): id is string => !!id)))
  return { accountIds, contactIds }
}

/**
 * Earlier transactions from the same sender (same name, or the same email in the memo), as
 * company/person rows. A hint for a person to read, never a rule that routes money.
 *
 * Skipped when the sender is only a payment RAIL ("WISE US INC", "Mercury", "Stripe"): such a name is
 * shared by dozens of unrelated clients, so its history says nothing about who paid. Rows that carry
 * an owner account number are TD's own money and never count.
 */
async function readPayerHistory(feed: FeedForSuggestions): Promise<PayerHistoryRow[] | null> {
  const name = normalizePayerName(feed.sender_name)
  const email = parsePayerEmail(feed.memo)
  const select = "id, sender_name, memo, transaction_date, payments:matched_payment_id(account_id, contact_id)"
  const base = () =>
    supabaseAdmin.from("td_bank_feeds").select(select)
      .eq("status", "matched").not("matched_payment_id", "is", null).neq("id", feed.id)
      .is("owner_account_number", null)
      .order("transaction_date", { ascending: false })

  const queries = []
  if (isUsablePayerName(name) && !isProcessorOnlyDescriptor(feed.sender_name)) {
    queries.push(base().ilike("sender_name", `%${escapeLikePattern(name)}%`).limit(HISTORY_LIMIT))
  }
  if (email) {
    queries.push(base().ilike("memo", `%${escapeLikePattern(email)}%`).limit(HISTORY_LIMIT))
  }
  if (queries.length === 0) return []

  const results = await Promise.all(queries)
  if (results.some((r) => r.error)) return null

  const seen = new Set<string>()
  const rows: PayerHistoryRow[] = []
  for (const r of results) {
    for (const f of (r.data ?? []) as unknown as Array<{ id: string; sender_name: string | null; memo: string | null; transaction_date: string | null; payments: { account_id: string | null; contact_id: string | null } | { account_id: string | null; contact_id: string | null }[] | null }>) {
      if (seen.has(f.id)) continue
      // The database narrowed by a loose pattern; the same sender is decided here, exactly: the
      // same normalized name, or the very same email address (not one that merely contains it).
      const sameName = isUsablePayerName(name) && normalizePayerName(f.sender_name) === name
      const sameEmail = !!email && parsePayerEmail(f.memo) === email
      if (!sameName && !sameEmail) continue
      seen.add(f.id)
      const p = first(f.payments)
      if (p) rows.push({ account_id: p.account_id, contact_id: p.contact_id, transaction_date: f.transaction_date })
    }
  }
  return rows
}

export async function loadPayerInvoices(params: {
  feedId: string
  /** A company the person searched for — skips the payer history and lists that company's invoices. */
  accountId?: string | null
  contactId?: string | null
  isOwner: boolean
}): Promise<PayerInvoicesResult> {
  const { data: feedRow, error: feedErr } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, sender_name, sender_reference, raw_data, memo, amount, currency, transaction_date, status, owner_account_number")
    .eq("id", params.feedId)
    .maybeSingle()
  if (feedErr) return { ok: false, error: `Could not read the transaction: ${feedErr.message}` }
  if (!feedRow) return { ok: false, error: "Transaction not found." }
  const feed = feedRow as unknown as FeedForSuggestions

  // TD's own money is the owner's business, not the staff's — the same rule the Bank Feed page applies.
  const privateToOwner = feed.status === "outgoing" || feed.status === "owner_ledger" || !!feed.owner_account_number
  if (privateToOwner && !params.isOwner) return { ok: false, error: "Transaction not found." }

  const payerName = feed.sender_name?.trim() || null
  const payerEmail = parsePayerEmail(feed.memo)

  // 1. Which companies / people. The CRM identity of the billing email first (strongest), then
  //    where earlier payments from this sender were linked. Every candidate is listed, none picked.
  let companies: PayerCompanyInfo[] = []
  if (params.accountId || params.contactId) {
    const kind = params.accountId ? "account" : "contact"
    const id = (params.accountId ?? params.contactId) as string
    companies = [{ kind, id, name: "", source: "search", times_linked: 0, last_linked: null }]
  } else {
    const identity = await readEmailIdentity(feed)
    if (identity === null) return { ok: false, error: "Could not look up who this payment's email belongs to." }
    const history = await readPayerHistory(feed)
    if (history === null) return { ok: false, error: "Could not read this payer's earlier payments." }

    const merged = new Map<string, PayerCompanyInfo>()
    const add = (c: PayerCompanyInfo) => {
      const key = `${c.kind}:${c.id}`
      const existing = merged.get(key)
      if (!existing) merged.set(key, c)
      else if (c.source === "email") merged.set(key, { ...existing, source: "email" })
    }
    // Companies first (the CRM identity of the email, then where earlier payments went), the people
    // after — so a shared mailbox's many contacts can never crowd a company out of the list.
    for (const id of identity.accountIds) add({ kind: "account", id, name: "", source: "email", times_linked: 0, last_linked: null })
    for (const c of rankPayerCompanies(history, 3)) add({ ...c, name: "", source: "history" })
    for (const id of identity.contactIds) add({ kind: "contact", id, name: "", source: "email", times_linked: 0, last_linked: null })
    // History counts also decorate an email-identified company that appears in both.
    for (const c of rankPayerCompanies(history, 50)) {
      const existing = merged.get(`${c.kind}:${c.id}`)
      if (existing && existing.times_linked === 0) merged.set(`${c.kind}:${c.id}`, { ...existing, times_linked: c.times_linked, last_linked: c.last_linked })
    }
    companies = Array.from(merged.values()).slice(0, MAX_COMPANIES)
  }
  if (companies.length === 0) {
    return { ok: true, payer: { name: payerName, email: payerEmail }, companies: [], invoices: [], combos: [], truncated: false }
  }

  // 2. Their invoices.
  const accountIds = companies.filter((c) => c.kind === "account").map((c) => c.id)
  const contactIds = companies.filter((c) => c.kind === "contact").map((c) => c.id)
  // One query per company/person, so a big company's invoices cannot crowd a small one out.
  const perOwner = (column: "account_id" | "contact_id", id: string) => {
    let q = supabaseAdmin.from("payments").select(INVOICE_COLUMNS).eq(column, id).not("is_test", "is", true)
    if (column === "contact_id") q = q.is("account_id", null)
    return q.order("paid_date", { ascending: false, nullsFirst: true }).order("created_at", { ascending: false }).limit(INVOICE_LIMIT)
  }
  const [ownerResults, accountNames, contactNames] = await Promise.all([
    Promise.all([
      ...accountIds.map((id) => perOwner("account_id", id)),
      ...contactIds.map((id) => perOwner("contact_id", id)),
    ]),
    accountIds.length ? supabaseAdmin.from("accounts").select("id, company_name").in("id", accountIds) : Promise.resolve({ data: [], error: null }),
    contactIds.length ? supabaseAdmin.from("contacts").select("id, full_name").in("id", contactIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (ownerResults.some((r) => r.error)) return { ok: false, error: "Could not read the invoices." }

  const nameById = new Map<string, string>()
  for (const a of (accountNames.data ?? []) as Array<{ id: string; company_name: string | null }>) nameById.set(`account:${a.id}`, a.company_name ?? "—")
  for (const c of (contactNames.data ?? []) as Array<{ id: string; full_name: string | null }>) nameById.set(`contact:${c.id}`, c.full_name ?? "—")
  companies = companies.map((c) => ({ ...c, name: nameById.get(`${c.kind}:${c.id}`) ?? "—" }))

  const raw = ownerResults.flatMap((r) => (r.data ?? []) as unknown as RawInvoice[])
  const truncated = ownerResults.some((r) => (r.data ?? []).length >= INVOICE_LIMIT)
  const linkable = raw.filter(isLinkableForSuggestion)

  // 3. Which already-PAID invoices are tied to another transaction. Only a paid invoice can be
  //    "taken": an unpaid or part-paid one is still owed money, and a second payment toward it is normal.
  const claimed = await readClaimedInvoiceIds(linkable.filter((i) => isPaidInvoice(i)).map((i) => i.id), feed.id)
  if (claimed === null) return { ok: false, error: "Could not check which invoices are already linked to another payment." }

  const invoices = linkable
    .map((i) => toPayerInvoice(i, claimed))
    // Owed first (that is what usually needs attention), then paid, newest paid date first.
    .sort((a, b) => Number(a.paid) - Number(b.paid) || String(b.paid_date ?? "").localeCompare(String(a.paid_date ?? "")))

  // 4. Sets that add up to the payment exactly. Already-paid invoices (linked for the record) and
  //    unpaid ones (the payment is applied to them) cannot be linked together, so each kind is
  //    searched on its own — every set offered can actually be linked in one step.
  const feedCurrency = String(feed.currency ?? "USD")
  const comboPool = (paid: boolean) =>
    invoices
      .filter((i) => i.paid === paid)
      .map((i) => ({
        id: i.id,
        amount: (i.paid ? i.total : i.balance) ?? 0,
        currency: i.currency ?? "USD",
        paid: i.paid,
        paid_date: i.paid_date,
        claimed_by_other: i.claimed_by_other,
      }))
  const combos: ExactCombo[] = [
    ...findExactCombos(Number(feed.amount), feed.transaction_date, feedCurrency, comboPool(true)),
    ...findExactCombos(Number(feed.amount), feed.transaction_date, feedCurrency, comboPool(false)),
  ]
    .sort((a, b) => Number(b.dates_match) - Number(a.dates_match) || a.ids.length - b.ids.length)
    .slice(0, MAX_COMBOS_OFFERED)

  return { ok: true, payer: { name: payerName, email: payerEmail }, companies, invoices, combos, truncated }
}
