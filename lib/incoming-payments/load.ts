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
import { INCOMING_PAYMENTS_SINCE, pickWaiting, type PayerMatch, type WaitingPayment, type WaitingRow } from "@/lib/incoming-payments/classify"

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
  for (const w of waiting) rows.push({ ...w, match: await matchesFor(w.email) })
  return rows
}

export async function countWaitingPayments(): Promise<number> {
  return (await loadWaitingPayments()).length
}

async function matchesFor(email: string | null): Promise<PayerMatch> {
  const empty: PayerMatch = { leads: [], contacts: [], marketingLeads: [] }
  if (!email) return empty
  // ilike with the address as-is would treat % and _ as wildcards: escape them so only this exact address matches.
  const exact = email.replace(/[\\%_]/g, (c) => `\\${c}`)
  const [leads, contacts, mkt] = await Promise.all([
    supabaseAdmin.from("leads").select("id, full_name, status").ilike("email", exact).limit(5),
    supabaseAdmin.from("contacts").select("id, full_name").ilike("email", exact).limit(5),
    supabaseAdmin.from("marketing_leads").select("id, full_name").ilike("email", exact).limit(5),
  ])
  for (const r of [leads, contacts]) if (r.error) throw new Error(`incoming-payments: could not look up the payer: ${r.error.message}`)
  // The marketing workspace's tables are not installed on every database (the sandbox has none): ONLY "that table does not exist"
  // means "no marketing lead". Any other failure is a real read error and must stop the list, never hide a marketing warning.
  const mktMissing = mkt.error && (mkt.error.code === "PGRST205" || mkt.error.code === "42P01")
  if (mkt.error && !mktMissing) throw new Error(`incoming-payments: could not look up the marketing leads: ${mkt.error.message}`)
  return {
    leads: ((leads.data ?? []) as Array<{ id: string; full_name: string | null; status: string | null }>).map((l) => ({ id: l.id, name: l.full_name ?? "", status: String(l.status ?? "") })),
    contacts: ((contacts.data ?? []) as Array<{ id: string; full_name: string | null }>).map((c) => ({ id: c.id, name: c.full_name ?? "" })),
    marketingLeads: mktMissing ? [] : ((mkt.data ?? []) as Array<{ id: string; full_name: string | null }>).map((m) => ({ id: m.id, name: m.full_name ?? "" })),
  }
}
