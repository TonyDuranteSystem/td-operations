/**
 * Payments to confirm — the loader. SERVER-ONLY, READ-ONLY. Throws on any read error: a half-read must never render as an
 * empty "nothing waiting" (the Calendar shows "Could not load" instead).
 *
 * The waiting list is DERIVED, not stored: the saved Stripe events (webhook_events) since INCOMING_PAYMENTS_SINCE that carry no
 * label, minus the sessions already settled (incoming_payment_resolutions) and minus any payment that already has a row in
 * `payments` under its Stripe id. That is also why payments that arrived BEFORE this existed (Christian, Monica, ...) show up
 * without any backfill.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { INCOMING_PAYMENTS_SINCE, pickWaiting, type MarketingLeadChoice, type MarketingSuggestion, type PayerMatch, type WaitingPayment, type WaitingRow } from "@/lib/incoming-payments/classify"
import { nameSignificantWords } from "@/lib/finance/feed-signals"
import { getMarketingSetting, listCommissionTerms } from "@/lib/marketing/settings"
import { snapshotForSale } from "@/lib/marketing/sales"
import { loadOpenInvoicesForPayer } from "@/lib/incoming-payments/invoice-payment"

// The table is not in the generated types yet (it arrives with the next types regeneration).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const EVENT_LIMIT = 1000
const CHUNK = 100

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n))
  return out
}

/** The stored event for one session (the confirm step re-reads it: nothing about the money is ever taken from the browser). */
export async function loadWaitingPaymentBySession(sessionId: string): Promise<WaitingPayment | null> {
  const { data, error } = await supabaseAdmin
    .from("webhook_events")
    .select("created_at, payload")
    .eq("source", "stripe")
    .eq("event_type", "checkout.session.completed")
    .eq("external_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) throw new Error(`incoming-payments: could not read the Stripe event: ${error.message}`)
  const ev = (data ?? [])[0] as { created_at: string; payload: Record<string, unknown> | null } | undefined
  if (!ev) return null
  return pickWaiting([ev], { sessionIds: new Set(), stripeIds: new Set() })[0] ?? null
}

export async function loadWaitingPayments(): Promise<WaitingRow[]> {
  const { data: evs, error } = await supabaseAdmin
    .from("webhook_events")
    .select("created_at, payload")
    .eq("source", "stripe")
    .eq("event_type", "checkout.session.completed")
    .gte("created_at", INCOMING_PAYMENTS_SINCE)
    .order("created_at", { ascending: false })
    .limit(EVENT_LIMIT)
  if (error) throw new Error(`incoming-payments: could not read the Stripe events: ${error.message}`)
  const events = (evs ?? []) as Array<{ created_at: string; payload: Record<string, unknown> | null }>

  const { data: res, error: resErr } = await db()
    .from("incoming_payment_resolutions")
    .select("stripe_session_id")
    .limit(5000)
  if (resErr) throw new Error(`incoming-payments: could not read the settled payments: ${resErr.message}`)
  const sessionIds = new Set(((res ?? []) as Array<{ stripe_session_id: string }>).map((r) => r.stripe_session_id))

  // Candidates first (cheap), so the payments lookup only asks about those.
  const candidates = pickWaiting(events, { sessionIds, stripeIds: new Set() })
  const ids = Array.from(new Set(candidates.flatMap((c) => [c.sessionId, c.paymentIntentId].filter((x): x is string => !!x))))
  const stripeIds = new Set<string>()
  for (const part of chunks(ids, CHUNK)) {
    const { data: pays, error: payErr } = await supabaseAdmin.from("payments").select("stripe_payment_id").in("stripe_payment_id", part)
    if (payErr) throw new Error(`incoming-payments: could not read payments: ${payErr.message}`)
    for (const p of (pays ?? []) as Array<{ stripe_payment_id: string | null }>) if (p.stripe_payment_id) stripeIds.add(p.stripe_payment_id)
  }
  const waiting = pickWaiting(events, { sessionIds, stripeIds })

  const rows: WaitingRow[] = []
  for (const w of waiting) {
    const match = await matchesFor(w.email, w.name)
    rows.push({ ...w, match, invoices: await loadOpenInvoicesForPayer(w.email), marketingSuggestion: await marketingSuggestionFor(w, match) })
  }
  return rows
}

export async function countWaitingPayments(): Promise<number> {
  return (await loadWaitingPayments()).length
}

export async function matchesFor(email: string | null, payerName: string | null = null): Promise<PayerMatch> {
  const empty: PayerMatch = { leads: [], contacts: [], marketingLeads: [] }
  if (!email) {
    // No email on the payment: the only evidence left is the name (suggestions only).
    return { ...empty, marketingLeads: await marketingLeadsByName(payerName, []) }
  }
  // ilike with the address as-is would treat % and _ as wildcards: escape them so only this exact address matches.
  const exact = email.replace(/[\\%_]/g, (c) => `\\${c}`)
  const [leads, contacts, mkt] = await Promise.all([
    supabaseAdmin.from("leads").select("id, full_name, status").ilike("email", exact).limit(5),
    supabaseAdmin.from("contacts").select("id, full_name").ilike("email", exact).limit(5),
    supabaseAdmin.from("marketing_leads").select("id, full_name, email, team_id").ilike("email", exact).limit(5),
  ])
  for (const r of [leads, contacts]) if (r.error) throw new Error(`incoming-payments: could not look up the payer: ${r.error.message}`)
  // The marketing workspace's tables are not installed on every database (the sandbox has none): ONLY "that table does not exist"
  // means "no marketing lead". Any other failure is a real read error and must stop the list, never hide a marketing warning.
  const mktMissing = mkt.error && (mkt.error.code === "PGRST205" || mkt.error.code === "42P01")
  if (mkt.error && !mktMissing) throw new Error(`incoming-payments: could not look up the marketing leads: ${mkt.error.message}`)
  return {
    leads: ((leads.data ?? []) as Array<{ id: string; full_name: string | null; status: string | null }>).map((l) => ({ id: l.id, name: l.full_name ?? "", status: String(l.status ?? "") })),
    contacts: ((contacts.data ?? []) as Array<{ id: string; full_name: string | null }>).map((c) => ({ id: c.id, name: c.full_name ?? "" })),
    marketingLeads: mktMissing ? [] : await withNameMatches((await toChoices((mkt.data ?? []) as MarketingLeadRow[])).map((c) => ({ ...c, via: "email" as const })), payerName),
  }
}

/** Email matches first, then lead names that look like the payer's name (never repeating a lead already listed). */
async function withNameMatches(byEmail: MarketingLeadChoice[], payerName: string | null): Promise<MarketingLeadChoice[]> {
  const byName = await marketingLeadsByName(payerName, byEmail.map((c) => c.id))
  return [...byEmail, ...byName]
}

/**
 * Marketing leads whose NAME shares significant words with the payer's name ("Stella Germani M" ~ "Monica Germani": Germani). SUGGESTIONS
 * ONLY — a wrong name match once settled the wrong client in the bank feed, so these are labelled "similar name", ranked by shared words, capped
 * at 5, and never pre-selected. Words come from the same tokenizer the bank feed uses (accents folded, short and stop words dropped), so only
 * [a-z0-9] reaches the filter: nothing typed can become an operator or a wildcard. A missing marketing table = no suggestions.
 */
export async function marketingLeadsByName(payerName: string | null, excludeIds: string[]): Promise<MarketingLeadChoice[]> {
  const words = payerName ? nameSignificantWords(payerName) : []
  if (words.length === 0) return []
  const { data, error } = await db()
    .from("marketing_leads")
    .select("id, full_name, email, team_id")
    .or(words.map((w) => `full_name.ilike.%${w}%`).join(","))
    .order("received_at", { ascending: false })
    .limit(30)
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return []
    throw new Error(`incoming-payments: could not look up marketing leads by name: ${error.message}`)
  }
  const skip = new Set(excludeIds)
  const ranked = ((data ?? []) as MarketingLeadRow[])
    .filter((r) => !skip.has(r.id))
    .map((r) => ({ r, shared: nameSignificantWords(r.full_name ?? "").filter((w) => words.includes(w)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 5)
    .map((x) => x.r)
  return (await toChoices(ranked)).map((c) => ({ ...c, via: "name" as const }))
}

/**
 * "Looks like a marketing sale": exactly ONE marketing lead has the payer's email and sits on a team that offers the usual call kind. Returns a
 * PREVIEW of the split in force on the day of payment (the same rule the confirm step applies). null = no clear suggestion; nothing is recorded.
 */
export async function marketingSuggestionFor(w: WaitingPayment, match: PayerMatch): Promise<MarketingSuggestion | null> {
  const byEmail = match.marketingLeads.filter((l) => l.via === "email")
  if (byEmail.length !== 1) return null
  const lead = byEmail[0]
  if (!lead.teamId) return null
  const kind = lead.kinds.find((k) => k.key === "strategic_call")
  if (!kind) return null
  const [{ data: team, error }, terms] = await Promise.all([
    db().from("marketing_teams").select("name").eq("id", lead.teamId).maybeSingle(),
    listCommissionTerms(lead.teamId),
  ])
  if (error) throw new Error(`incoming-payments: could not read the marketing team: ${error.message}`)
  const paidAt = new Date(w.paidAt)
  const snap = snapshotForSale(terms, { teamId: lead.teamId, kind: kind.key, personRef: null, amountCents: Math.round(w.amount * 100), at: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt })
  const termSet = snap.seller_cents !== null && snap.td_cents !== null
  return {
    leadId: lead.id,
    leadName: lead.name,
    teamName: (team as { name?: string } | null)?.name ?? "the marketing team",
    kind: kind.key,
    kindLabel: kind.label,
    currency: w.currency,
    termSet,
    sellerAmount: termSet ? (snap.seller_cents as number) / 100 : null,
    tdAmount: termSet ? (snap.td_cents as number) / 100 : null,
  }
}

interface MarketingLeadRow { id: string; full_name: string | null; email: string | null; team_id: string | null }

/** Rows -> picker choices, each with the kinds of sale ITS team offers (read once per team). */
async function toChoices(rows: MarketingLeadRow[]): Promise<MarketingLeadChoice[]> {
  const kindsByTeam = new Map<string, Array<{ key: string; label: string }>>()
  for (const r of rows) {
    if (r.team_id && !kindsByTeam.has(r.team_id)) {
      kindsByTeam.set(r.team_id, (await getMarketingSetting("sale_kinds", r.team_id)) as Array<{ key: string; label: string }>)
    }
  }
  return rows.map((r) => ({ id: r.id, name: r.full_name ?? "", email: r.email, teamId: r.team_id, kinds: r.team_id ? kindsByTeam.get(r.team_id) ?? [] : [] }))
}

/**
 * Search the marketing leads by name or email (staff type a few letters). `available: false` = this database has no marketing tables
 * (only "table does not exist" counts; any other failure throws). A lead with no team cannot take a sale and says so (teamId null).
 */
export async function searchMarketingLeads(q: string): Promise<{ available: boolean; leads: MarketingLeadChoice[] }> {
  // Only letters, digits, spaces and the few marks a name or email holds survive: nothing typed can become a filter operator or a wildcard.
  // (ASCII letters/digits/marks, plus any character from code 192 up = accented letters and other scripts; the project's TS target has no /u regex flag.)
  const term = Array.from(q).filter((ch) => /[A-Za-z0-9@.+\- ]/.test(ch) || ch.charCodeAt(0) >= 192).join("").trim().slice(0, 80)
  if (term.length < 2) return { available: true, leads: [] }
  const like = `%${term}%`
  const { data, error } = await db()
    .from("marketing_leads")
    .select("id, full_name, email, team_id")
    .or(`full_name.ilike.${like},email.ilike.${like}`)
    .order("received_at", { ascending: false })
    .limit(8)
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return { available: false, leads: [] }
    throw new Error(`incoming-payments: could not search the marketing leads: ${error.message}`)
  }
  return { available: true, leads: await toChoices((data ?? []) as MarketingLeadRow[]) }
}
