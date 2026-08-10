/**
 * Payer learning — the staff surface behind the triage list.
 *
 * Dev jobs `ae8b8bb1` / `c0a61e44`. Admin-only, same gate as My Finances itself: the role check
 * lives INSIDE the handler, not merely in page placement (the Finance privacy fix of 2026-07-27
 * is why — a page-level assumption leaked TD's own money to every staff account).
 *
 * ⛔ THIS ROUTE NEVER MOVES MONEY. It remembers, forgets and lists payers. Returning a
 * transaction to the Bank Feed stays with the existing `/api/owner/transactions/to-finance`
 * route, which already deletes the books copy BEFORE restoring the feed so the money can never
 * be counted twice. Duplicating that ordering here would be a second place to get it wrong.
 */
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  listMisroutedClientPaymentCandidates,
  type MisroutedCandidate,
} from "@/lib/finance/owner-ledger-projection"
import {
  listMappingsForKey,
  listSameOwnerCompanies,
  removePayerMapping,
  teachPayerClient,
} from "@/lib/finance/payer-learning"
import { evaluateTeachEligibility, resolvePayerKey } from "@/lib/finance/payer-learning-rules"

export const dynamic = "force-dynamic"

async function requireAdmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) return null
  return user
}

/** The feed fields the rules need, read fresh so nothing is trusted from the browser. */
async function loadFeed(feedId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const { data } = await (supabaseAdmin as any)
    .from("td_bank_feeds")
    .select("id, source, sender_name, memo, sender_reference, raw_data, status, amount, currency, transaction_date")
    .eq("id", feedId)
    .maybeSingle()
  return data as
    | {
        id: string
        source: string | null
        sender_name: string | null
        status: string | null
        raw_data: unknown
        amount: number | string
        currency: string | null
        transaction_date: string
      }
    | null
}

export interface CandidateWithTeachState extends MisroutedCandidate {
  /** May this payer be remembered at all, and if not, why — rendered to the user. */
  teachable: boolean
  teachRefusal?: string
  /** Clients already taught for this payer. */
  taughtFor: Array<{ id: string; accountId: string | null; contactId: string | null; label: string }>
}

export async function GET() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const result = await listMisroutedClientPaymentCandidates()
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not load the list." }, { status: 500 })
  }

  // Decorate each candidate with its teach state, so the screen never offers an action the
  // server would refuse — and never hides a refusal the person deserves to see.
  const decorated: CandidateWithTeachState[] = []
  for (const c of result.candidates) {
    const feed = await loadFeed(c.feedId)
    if (!feed) continue

    const eligibility = evaluateTeachEligibility(feed)
    const key = resolvePayerKey(feed)
    const mappings = key ? await listMappingsForKey(feed.source ?? "manual", key) : []

    decorated.push({
      ...c,
      teachable: eligibility.ok,
      ...(eligibility.ok ? {} : { teachRefusal: eligibility.detail }),
      taughtFor: await labelMappings(mappings),
    })
  }

  return NextResponse.json({ candidates: decorated, considered: result.considered })
}

async function labelMappings(
  mappings: Array<{ id: string; account_id: string | null; contact_id: string | null }>,
): Promise<CandidateWithTeachState["taughtFor"]> {
  const out: CandidateWithTeachState["taughtFor"] = []
  for (const m of mappings) {
    let label = "(unknown client)"
    if (m.account_id) {
      const { data } = await supabaseAdmin.from("accounts").select("company_name").eq("id", m.account_id).maybeSingle()
      label = data?.company_name ?? label
    } else if (m.contact_id) {
      const { data } = await supabaseAdmin.from("contacts").select("full_name").eq("id", m.contact_id).maybeSingle()
      label = data?.full_name ?? label
    }
    out.push({ id: m.id, accountId: m.account_id, contactId: m.contact_id, label })
  }
  return out
}

export async function POST(request: Request) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as {
    action?: string
    feedId?: string
    accountId?: string | null
    contactId?: string | null
    mappingId?: string
  }

  const actor = `finance-ui:${user.email ?? user.id}`

  if (body.action === "remove") {
    if (!body.mappingId) return NextResponse.json({ error: "Which mapping should be forgotten?" }, { status: 400 })
    const res = await removePayerMapping(body.mappingId, actor)
    if (!res.ok) return NextResponse.json({ error: res.error ?? "Could not forget this payer." }, { status: 500 })
    // `removed: false` means it was already gone — an honest answer, not an error.
    return NextResponse.json({ ok: true, removed: res.removed })
  }

  if (body.action === "teach") {
    if (!body.feedId) return NextResponse.json({ error: "Which transaction?" }, { status: 400 })
    const feed = await loadFeed(body.feedId)
    if (!feed) return NextResponse.json({ error: "That transaction no longer exists." }, { status: 404 })

    const res = await teachPayerClient({
      feed,
      subject: { accountId: body.accountId ?? null, contactId: body.contactId ?? null },
      taughtBy: actor,
      taughtVia: "confirmed from the triage list",
    })

    if (!res.ok) {
      // R099: the real reason travels to the user, never a generic failure.
      return NextResponse.json({ error: res.detail ?? "Could not remember this payer.", refusal: res.refusal }, { status: 400 })
    }

    const key = resolvePayerKey(feed)
    const sameOwner = body.accountId && key
      ? await listSameOwnerCompanies({ accountId: body.accountId, source: feed.source ?? "manual", key })
      : []

    return NextResponse.json({
      ok: true,
      created: res.created,
      mappingId: res.mappingId,
      taughtFor: await labelMappings(res.alsoTaughtFor ?? []),
      sameOwner,
    })
  }

  /**
   * TEACH FROM A MATCH — the same knowledge, captured where staff already work.
   *
   * Antonio has been matching payments by hand for months, and every one of those clicks carries
   * the answer this system is otherwise guessing at. This turns the routine bank-feed match into
   * a teaching moment: nine training examples become one per session, indefinitely.
   *
   * ⛔ THE CLIENT IS RESOLVED SERVER-SIDE FROM THE MATCHED INVOICE, never taken from the browser.
   * Same discipline as the public checkout route, which once let a request body decide what was
   * billable: the stored match IS the decision, so the body may name a transaction and nothing
   * else. It also means the mapping cannot disagree with the invoice it was learned from.
   */
  if (body.action === "teach_from_match") {
    if (!body.feedId) return NextResponse.json({ error: "Which transaction?" }, { status: 400 })

    const feed = await loadFeed(body.feedId)
    if (!feed) return NextResponse.json({ error: "That transaction no longer exists." }, { status: 404 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading the link the matcher wrote
    const { data: linked } = await (supabaseAdmin as any)
      .from("td_bank_feeds")
      .select("matched_payment_id")
      .eq("id", body.feedId)
      .maybeSingle()

    const paymentId = linked?.matched_payment_id as string | null
    if (!paymentId) {
      return NextResponse.json(
        { error: "This transaction is not matched to an invoice yet, so there is no client to remember it for." },
        { status: 400 },
      )
    }

    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select("account_id, contact_id, invoice_number")
      .eq("id", paymentId)
      .maybeSingle()

    if (!payment?.account_id && !payment?.contact_id) {
      return NextResponse.json(
        { error: "That invoice is not attached to a client, so there is nothing to remember." },
        { status: 400 },
      )
    }

    const res = await teachPayerClient({
      feed,
      // A company when the invoice has one, otherwise the person — an individual client with no
      // company is first-class here (34 of them hold real payments).
      subject: payment.account_id
        ? { accountId: payment.account_id }
        : { contactId: payment.contact_id },
      taughtBy: actor,
      taughtVia: `confirmed from a manual match on ${payment.invoice_number ?? "an invoice"}`,
    })

    if (!res.ok) {
      return NextResponse.json({ error: res.detail ?? "Could not remember this payer.", refusal: res.refusal }, { status: 400 })
    }

    return NextResponse.json({
      ok: true,
      created: res.created,
      mappingId: res.mappingId,
      taughtFor: await labelMappings(res.alsoTaughtFor ?? []),
    })
  }

  return NextResponse.json({ error: `Unknown action: ${body.action ?? "(none)"}` }, { status: 400 })
}
