/**
 * "What is this payment?" — an AI reads the system and BOTH mailboxes and says who paid and why.
 *
 *   POST /api/finance/investigate-payment   { feed_id: uuid, refresh?: boolean }
 *
 * Antonio, 2026-10-30: a €500 Airwallex payment from a man nobody had recorded was offered another client's
 * invoice because the amount matched. He asked for something smart that reads the whole context, searches
 * every mailbox, and keeps the story so the next person looking at that payment already has it.
 *
 * What it does and does not do:
 *  - OWNER ONLY. It searches the owner's personal mailbox, and what it finds is kept on the payment, where
 *    every staff member can read it.
 *  - READ ONLY. The AI worker is given read tools only (lib/finance/investigator-options.ts pins the set);
 *    this route writes exactly one thing: the result, under the payment's own `investigation` key.
 *  - Nothing is stored unless the AI produced a result block we could read. A reply that is only prose, or the
 *    loop's "I reached my working limit" notice, is SHOWN, never kept and never written on an invoice.
 *  - Cited ids are checked against the database / the mailbox sweep before they are trusted; a source is
 *    marked `verified` only when the SERVER saw it.
 *  - Never links, matches, creates or sends anything. A person decides.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { callWorker } from "@/lib/ai-agent/worker-tools"
import { executeTool } from "@/lib/ai-agent/tools"
import { allowedMailboxes } from "@/lib/ai-agent/gmail-mailbox"
import { updateFeed } from "@/lib/finance/feed-write"
import { checkRateLimit } from "@/lib/portal/rate-limit"
import { invoicePartyName } from "@/lib/finance/invoice-party"
import { buildInvestigatorWorkerOptions } from "@/lib/finance/investigator-options"
import {
  buildInvestigatorUserMessage,
  markVerifiedSources,
  parseInvestigationReply,
  payerFieldsFromRaw,
  payerSearchQueries,
  sweepMailboxes,
  type InvestigationFacts,
  type InvoiceContextRow,
  type MailboxSweep,
  type StoredInvestigation,
} from "@/lib/finance/feed-investigation"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A run that started this recently and never finished blocks a second one (a double click, a second tab). */
const IN_FLIGHT_MS = 5 * 60_000
/** The mailbox sweep gets this long before it is given up and reported as failed. */
const SWEEP_TIMEOUT_MS = 60_000
const MAX_CANDIDATE_INVOICES = 12

type Embedded<T> = T | T[] | null | undefined

interface FeedRow {
  id: string
  status: string | null
  owner_account_number: string | null
  source: string | null
  transaction_date: string | null
  amount: number | string | null
  currency: string | null
  sender_name: string | null
  sender_reference: string | null
  memo: string | null
  raw_data: unknown
  review_metadata: Record<string, unknown> | null
}

interface CandidateRow {
  id: string
  invoice_number: string | null
  description: string | null
  total: number | string | null
  invoice_status: string | null
  notes: string | null
  accounts: Embedded<{ company_name: string | null }>
  contacts: Embedded<{ full_name: string | null }>
}

/** Search the mailboxes, but never wait past the limit: a stuck Gmail call must not eat the whole run. */
async function sweepWithTimeout(queries: string[], mailboxes: string[]): Promise<MailboxSweep> {
  const timedOut: MailboxSweep = {
    queries,
    searched: [],
    failed: mailboxes.map((mailbox) => ({ mailbox, error: `the search took longer than ${SWEEP_TIMEOUT_MS / 1000}s and was given up` })),
    hits: [],
  }
  if (queries.length === 0) return { queries, searched: [...mailboxes], failed: [], hits: [] }
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<MailboxSweep>((resolve) => { timer = setTimeout(() => resolve(timedOut), SWEEP_TIMEOUT_MS) })
  try {
    return await Promise.race([sweepMailboxes((name, params) => executeTool(name, params), mailboxes, queries), limit])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Which of these ids really exist, per table — the model's ids are never trusted as they come. */
async function existingIds(table: "contacts" | "accounts" | "leads" | "payments", ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { data } = await supabaseAdmin.from(table).select("id").in("id", ids)
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id.toLowerCase()))
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isOwnerOnly(user)) {
    return NextResponse.json({ error: "Only the owner can run this for now: it searches the owner's personal mailbox." }, { status: 403 })
  }

  const rl = checkRateLimit(`feed-investigate:${user.id}`, 10, 10 * 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: `Too many investigations in a short time. Try again in ${rl.retryAfter ?? 60} seconds.` }, { status: 429 })
  }

  let body: { feed_id?: unknown; refresh?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }
  const feedId = typeof body.feed_id === "string" ? body.feed_id.trim() : ""
  if (!UUID.test(feedId)) return NextResponse.json({ error: "A transaction is required." }, { status: 400 })
  const refresh = body.refresh === true

  const { data: feedData } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, status, owner_account_number, source, transaction_date, amount, currency, sender_name, sender_reference, memo, raw_data, review_metadata")
    .eq("id", feedId)
    .maybeSingle()
  const feed = feedData as FeedRow | null
  if (!feed) return NextResponse.json({ error: "Transaction not found." }, { status: 404 })
  // TD's own private money is not investigated here, and nothing of it goes into a shared cache.
  if (feed.status === "outgoing" || feed.status === "owner_ledger" || feed.owner_account_number) {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 })
  }

  const meta = (feed.review_metadata && typeof feed.review_metadata === "object" ? feed.review_metadata : {}) as Record<string, unknown>
  if (meta.investigation && !refresh) {
    return NextResponse.json({ ok: true, cached: true, investigation: meta.investigation })
  }
  const startedAt = typeof meta.investigation_started_at === "string" ? Date.parse(meta.investigation_started_at) : NaN
  if (Number.isFinite(startedAt) && Date.now() - startedAt < IN_FLIGHT_MS) {
    return NextResponse.json({ error: "An investigation of this payment is already running. Wait for it to finish." }, { status: 409 })
  }

  const lock = await updateFeed(feed.id, { review_metadata: { investigation_started_at: new Date().toISOString() } }, "investigate-payment:start")
  if (!lock.ok) return NextResponse.json({ error: "Could not start the investigation. Try again." }, { status: 500 })

  const clearLock = () => updateFeed(feed.id, { review_metadata: { investigation_started_at: null } }, "investigate-payment:clear").catch(() => undefined)

  try {
    const amount = feed.amount == null ? null : Number(feed.amount)
    const payerFields = payerFieldsFromRaw(feed.raw_data)
    const facts: InvestigationFacts = {
      feed_id: feed.id,
      transaction_date: feed.transaction_date ? String(feed.transaction_date).slice(0, 10) : null,
      amount,
      currency: feed.currency,
      source: feed.source,
      sender_name: feed.sender_name,
      sender_reference: feed.sender_reference,
      memo: feed.memo,
      payer_fields: payerFields,
    }

    // Both mailboxes, guaranteed by code (see lib/finance/feed-investigation.ts).
    const mailboxes = allowedMailboxes()
    const queries = payerSearchQueries({ sender_name: feed.sender_name, memo: feed.memo, payer_name: payerFields.payer_name })
    const sweep = await sweepWithTimeout(queries, mailboxes)

    // Invoices of exactly this amount, so the model sees the "obvious" candidate and its internal note.
    let candidates: InvoiceContextRow[] = []
    if (amount !== null && feed.currency) {
      const { data: cand } = await supabaseAdmin
        .from("payments")
        .select("id, invoice_number, description, total, invoice_status, notes, accounts:account_id(company_name), contacts:payments_contact_id_fkey(full_name)")
        .eq("amount_currency", feed.currency as "USD" | "EUR")
        .or(`total.eq.${amount},amount_due.eq.${amount}`)
        .not("is_test", "is", true)
        .order("created_at", { ascending: false })
        .limit(MAX_CANDIDATE_INVOICES)
      candidates = ((cand ?? []) as unknown as CandidateRow[]).map((c) => ({
        id: c.id,
        invoice_number: c.invoice_number,
        party: invoicePartyName({ accounts: c.accounts, contacts: c.contacts }),
        description: c.description,
        total: c.total == null ? null : Number(c.total),
        status: c.invoice_status,
        notes: c.notes,
      }))
    }

    const userMessage = buildInvestigatorUserMessage(facts, sweep, candidates)
    const worker = await callWorker(userMessage, buildInvestigatorWorkerOptions())

    if (worker.reachedMaxLoops) {
      await clearLock()
      return NextResponse.json({
        ok: true,
        investigation: null,
        unfinished: true,
        text: "The investigation ran out of steps before it reached a conclusion. Nothing was saved. Try again, or search by hand.",
      })
    }

    const parsed = parseInvestigationReply(worker.reply)
    if (!parsed.parsed) {
      await clearLock()
      return NextResponse.json({
        ok: true,
        investigation: null,
        unfinished: true,
        text: parsed.story || "The assistant did not give a result. Nothing was saved.",
      })
    }

    // Trust nothing the model cites until the database (or the sweep) confirms it.
    const who = parsed.who
    const wantContacts = who?.contact_id ? [who.contact_id] : []
    const wantAccounts = who?.account_id ? [who.account_id] : []
    const wantLeads = who?.lead_id ? [who.lead_id] : []
    const wantPayments = parsed.suggested_invoice_ids
    const sourceRecordIds = parsed.sources.filter((s) => s.kind !== "email" && s.id).map((s) => (s.id as string).toLowerCase()).filter((id) => UUID.test(id))
    const [okContacts, okAccounts, okLeads, okPayments, okSourceContacts, okSourceAccounts, okSourcePayments] = await Promise.all([
      existingIds("contacts", wantContacts),
      existingIds("accounts", wantAccounts),
      existingIds("leads", wantLeads),
      existingIds("payments", wantPayments),
      existingIds("contacts", sourceRecordIds),
      existingIds("accounts", sourceRecordIds),
      existingIds("payments", sourceRecordIds),
    ])
    const checkedWho = who
      ? {
          name: who.name,
          contact_id: who.contact_id && okContacts.has(who.contact_id) ? who.contact_id : null,
          account_id: who.account_id && okAccounts.has(who.account_id) ? who.account_id : null,
          lead_id: who.lead_id && okLeads.has(who.lead_id) ? who.lead_id : null,
        }
      : null
    const emailIds = new Set(sweep.hits.flatMap((h) => [h.id, h.thread_id].filter(Boolean)))
    const recordIds = new Set<string>()
    okSourceContacts.forEach((id) => recordIds.add(id))
    okSourceAccounts.forEach((id) => recordIds.add(id))
    okSourcePayments.forEach((id) => recordIds.add(id))

    const stored: StoredInvestigation = {
      verdict: parsed.verdict,
      who: checkedWho && (checkedWho.name || checkedWho.contact_id || checkedWho.account_id || checkedWho.lead_id) ? checkedWho : null,
      summary: parsed.summary,
      story: parsed.story,
      sources: markVerifiedSources(parsed.sources, { emailIds, recordIds }),
      suggested_invoice_ids: parsed.suggested_invoice_ids.filter((id) => okPayments.has(id)),
      suggested_next: parsed.suggested_next,
      at: new Date().toISOString(),
      by: user.id,
      tools_used: Array.from(new Set(worker.toolsUsed)),
      mailboxes_searched: sweep.searched,
      mailboxes_failed: sweep.failed.map((f) => `${f.mailbox}: ${f.error}`),
    }

    const saved = await updateFeed(feed.id, { review_metadata: { investigation: stored, investigation_started_at: null } }, "investigate-payment:result")
    if (!saved.ok) await clearLock()
    return NextResponse.json({ ok: true, cached: false, investigation: stored, saved: saved.ok })
  } catch (err) {
    await clearLock()
    const message = err instanceof Error ? err.message : String(err)
    console.error("[investigate-payment] failed:", message)
    const notConfigured = /ANTHROPIC_API_KEY/.test(message)
    return NextResponse.json(
      { error: notConfigured ? "The AI assistant is not set up on this environment (no API key)." : "The investigation failed. Nothing was saved. Try again in a moment." },
      { status: 500 },
    )
  }
}
