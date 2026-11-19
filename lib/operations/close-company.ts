/**
 * Company Closure — what "Closing" does to the company, and the facts the ask-first question shows before it does it
 * (Company Closure Part C, dev job a6bbea09; replaces the inline block "14. Company Closure" of lib/service-delivery.ts).
 *
 * What the job's last step does when a closure job reaches "Closing":
 *   1. cancels every OTHER open service of the company — active, ON HOLD and BLOCKED ones (only active ones used to be cancelled, so
 *      a held tax return or a blocked renewal lived on for a company that no longer exists) — through `deactivateSD`, which also
 *      stamps the end date and clears a renewal date so the nightly cron does not re-create it;
 *   2. cancels the company's pending deadlines (a renewal reminder for a closed company is noise);
 *   3. cancels the company's unpaid invoices (Pending / Overdue, nothing received) — the same default the manual "Closed" status change has
 *      always had, done the way Finance's Void does it (both status columns, the client's copy rebuilt, the before-state recorded for
 *      "Reactivate"); the question shows them first so staff can collect before saying yes. Paid invoices are never touched, a PART-PAID
 *      invoice is left open and reported (money was received on it), an unused credit note is left alone (lib/closure/closing-payments.ts);
 *   4. closes the company's open to-dos: this job's own as Done (except its "[CLOSURE]" follow-up cards, which are real work still to do),
 *      every other as CANCELLED (they were never done — marking them Done made unrelated work look completed);
 *   5. sets the company to Closed, turns its portal off, marks its portal level inactive and recomputes every linked person's level
 *      (the manual status change did all of it; the job's last step left the level at "active");
 *   6. leaves the follow-up to-dos (lib/services/closure-cascade.ts): the Registered Agent on Harbor, and the lease when there is one.
 *
 * It is IDEMPOTENT: every step is safe to run again, and a company that is ALREADY Closed is only tidied (whatever is still open for it is
 * cancelled) — it is not closed a second time and the follow-up to-dos are NOT created a second time (finishing twice, or going back and
 * finishing again, used to re-run everything and duplicate the follow-up to-dos). It also no longer lies: every write is checked, and any
 * step that failed comes back in `problems` so the screen can say so instead of reporting success.
 *
 * Each step is independent: one that fails is reported and does not stop the others (a company whose invoices could not be cancelled is
 * still closed — and the warning says what to do by hand). The company is set to Closed after the clean-up steps.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { buildClosureFollowUpCards, isClosureFollowUpTitle, type ClosureStepTask } from "@/lib/services/closure-cascade"
import type { ClosingBrief } from "@/lib/closure/closing-brief"
import { classifyOpenPayments, owedOf, paidOf, totalsByCurrency, type OpenPaymentRow } from "@/lib/closure/closing-payments"
import { CHECK_CLEARED_MARKER } from "@/lib/closure/wizard-move-guard"
import { belongsToKeptOffer, CLOSING_MARKER_LIKE, endedNote, holdingReturns, isWaitingClosureJob, keptOfferTokens, newestMarker, returnLabel, waitsNote, type OpenJob } from "@/lib/closure/pending-return"
import { TAX_RETURN_SERVICES } from "@/lib/closure/wrapup-facts"

const OPEN_SERVICE = ["active", "on_hold", "blocked"] as const
const OPEN_TODO = ["To Do", "In Progress", "Waiting"] as const
const LIVE_LEASE = ["signed", "viewed", "sent"] as const

export interface CompanyClosureResult {
  alreadyClosed: boolean
  /** a Tax Return still to be filed holds the closing: the company stays open (portal on) until it is filed (dev job 0a60f416, part C) */
  waiting?: boolean
  /** one line per thing that happened — they go into the advance result's auto_triggers */
  lines: string[]
  /** steps that FAILED — shown to staff as a warning, never swallowed */
  problems: string[]
}

type Row = Record<string, unknown>

function money(rows: Array<{ amount: number | string | null; amount_currency: string | null }>): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const r of rows) {
    const cur = (r.amount_currency || "USD").toUpperCase()
    totals[cur] = Math.round(((totals[cur] ?? 0) + Number(r.amount ?? 0)) * 100) / 100
  }
  return totals
}

/**
 * The text after "CHECK:" in the latest note the closure wizard left on the job when the client wrote a different company — unless a
 * newer "CHECK cleared:" note says the client has since written the right one (the finish question kept showing the old warning after
 * the client corrected the name — seen live on production 2026-11-08). `notes` are newest first.
 */
export function checkNoteFrom(notes: ReadonlyArray<{ body: string | null }>): string | null {
  for (const n of notes) {
    const body = n.body ?? ""
    if (body.includes(CHECK_CLEARED_MARKER)) return null
    const i = body.indexOf("CHECK:")
    if (i >= 0) return body.slice(i + "CHECK:".length).trim() || null
  }
  return null
}

/** Everything the ask-first question shows. Returns null for a job with no company (nothing would be closed). THROWS on a read error. */
export async function readClosingBrief(serviceDeliveryId: string): Promise<ClosingBrief | null> {
  const { data: sd, error: sdErr } = await supabaseAdmin.from("service_deliveries").select("id, account_id").eq("id", serviceDeliveryId).maybeSingle()
  if (sdErr) throw new Error(`closing brief: could not read the job: ${sdErr.message}`)
  const accountId = (sd as Row | null)?.account_id as string | null | undefined
  if (!accountId) return null

  const { data: acct, error: aErr } = await supabaseAdmin.from("accounts").select("company_name, status").eq("id", accountId).maybeSingle()
  if (aErr) throw new Error(`closing brief: could not read the company: ${aErr.message}`)
  if (!acct) return null

  const [services, deadlines, payments, tasks, members, leases, notes] = await Promise.all([
    supabaseAdmin.from("service_deliveries").select("id, service_type, status, stage, service_name, source_offer_token").eq("account_id", accountId).in("status", [...OPEN_SERVICE]).neq("id", serviceDeliveryId),
    supabaseAdmin.from("deadlines").select("id, deadline_type").eq("account_id", accountId).eq("status", "Pending"),
    supabaseAdmin.from("payments").select("id, invoice_number, status, invoice_status, amount, amount_currency, amount_due, amount_paid, tranche_offer_token").eq("account_id", accountId).in("status", ["Pending", "Overdue"]),
    supabaseAdmin.from("tasks").select("id, delivery_id").eq("account_id", accountId).in("status", [...OPEN_TODO]),
    supabaseAdmin.from("account_contacts").select("contact_id", { count: "exact", head: true }).eq("account_id", accountId).is("ended_at", null),
    supabaseAdmin.from("lease_agreements").select("id", { count: "exact", head: true }).eq("account_id", accountId).in("status", [...LIVE_LEASE]),
    supabaseAdmin.from("service_delivery_notes").select("body").eq("service_delivery_id", serviceDeliveryId).ilike("body", "%CHECK%").order("created_at", { ascending: false }).limit(10),
  ])
  for (const [name, r] of Object.entries({ services, deadlines, payments, tasks, members, leases, notes })) {
    if (r.error) throw new Error(`closing brief: could not read ${name}: ${r.error.message}`)
  }

  // Only rows closing will really cancel are "unpaid invoices"; a part-paid invoice and an unused credit note are listed apart (closing-payments.ts).
  // A Tax Return still to be filed holds the closing (dev job 0a60f416, part C): it, its to-dos and the unpaid invoices of its offer are NOT cancelled.
  const openJobs = (services.data ?? []) as OpenJob[]
  const alreadyClosed = String((acct as Row).status ?? "").toLowerCase() === "closed"
  // A company that is already Closed is only tidied: the step cancels everything still open, so nothing is promised as kept.
  const kept = alreadyClosed ? [] : holdingReturns(openJobs)
  const keptIds = new Set(kept.map((k) => k.id))
  const keptTokens = keptOfferTokens(kept)
  const classified = classifyOpenPayments(((payments.data ?? []) as Array<OpenPaymentRow & { tranche_offer_token?: string | null }>).filter((p) => !belongsToKeptOffer(p, keptTokens)))
  return {
    companyName: (acct as Row).company_name as string,
    alreadyClosed,
    openServices: openJobs.filter((j) => !keptIds.has(j.id)).map((s) => ({ type: s.service_type, status: String(s.status ?? "") })),
    keptReturns: kept.map(returnLabel),
    // the final return's own tax deadlines are not cancelled, so they are not counted as such
    pendingDeadlines: ((deadlines.data ?? []) as Array<{ deadline_type?: string | null }>).filter((d) => kept.length === 0 || !/tax/i.test(d.deadline_type ?? "")).length,
    unpaid: { count: classified.cancel.length, totals: totalsByCurrency<OpenPaymentRow>(classified.cancel, owedOf) },
    partPaid: classified.partPaid.map((p) => ({ invoice: p.invoice_number || p.id, paid: paidOf(p), owed: owedOf(p), currency: (p.amount_currency || "USD").toUpperCase() })),
    credits: { count: classified.credits.length, totals: totalsByCurrency<OpenPaymentRow>(classified.credits, (r) => Math.abs(Number(r.amount ?? 0))) },
    openTasks: ((tasks.data ?? []) as Array<{ delivery_id: string | null }>).filter((t) => t.delivery_id !== serviceDeliveryId && !(t.delivery_id && keptIds.has(t.delivery_id))).length,
    members: members.count ?? 0,
    hasLease: (leases.count ?? 0) > 0,
    checkNote: checkNoteFrom((notes.data ?? []) as Array<{ body: string | null }>),
  }
}

/**
 * Close the company a finished closure job belongs to. Never throws for a failed step — it reports it in `problems`.
 * @param wrapUpStepExists whether the Company Closure step list has the (dormant) "Wrap-up" step — passed on to the follow-up to-dos.
 */
export async function applyCompanyClosure(p: { accountId: string; deliveryId: string; wrapUpStepExists: boolean; /** the closure's own follow-up to-dos were already created (the completion after a held closing) */ skipFollowUps?: boolean; /** offers of the final tax return(s) now filed: their unpaid invoices are REPORTED to staff, never cancelled silently (the completion after a held closing) */ protectOfferTokens?: readonly string[] }): Promise<CompanyClosureResult> {
  const { accountId, deliveryId, wrapUpStepExists } = p
  const lines: string[] = []
  const problems: string[] = []
  const fail = (what: string, why: unknown) => problems.push(`${what}: ${why instanceof Error ? why.message : String(why)}`)

  // Read the job's own to-dos FIRST — the clean-up below closes them, and a Wrap-up chore nobody did must come back as a follow-up.
  let jobTasks: ClosureStepTask[] = []
  try {
    const { data } = await supabaseAdmin.from("tasks").select("task_title, status").eq("delivery_id", deliveryId)
    jobTasks = (data ?? []) as ClosureStepTask[]
  } catch {
    /* unreadable → every chore gets its follow-up (the safe direction) */
  }

  // Already Closed → it is only tidied, never closed twice and never given the follow-up to-dos twice. A read error here is a problem
  // of its own: stop before changing anything rather than guess.
  let wasClosed = false
  try {
    const { data: acct, error } = await supabaseAdmin.from("accounts").select("status").eq("id", accountId).maybeSingle()
    if (error) throw new Error(error.message)
    wasClosed = String((acct as Row | null)?.status ?? "").toLowerCase() === "closed"
  } catch (e) {
    return { alreadyClosed: false, lines, problems: [`could not check the company's status (${e instanceof Error ? e.message : String(e)}) — nothing was changed`] }
  }
  if (wasClosed) lines.push("Company was already Closed — only what was still open for it was tidied")

  // A Tax Return still to be filed HOLDS the closing (dev job 0a60f416, part C; Antonio 2026-10-15 "choice B", 2026-11-19 for Carasso): it, its to-dos, its
  // tax deadlines and the unpaid invoices of its offer are left alone, and the company stays open (portal on) until it is filed. A read error stops everything.
  let kept: OpenJob[] = []
  if (!wasClosed) {
    try {
      const { data, error } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, service_type, status, stage, service_name, source_offer_token")
        .eq("account_id", accountId)
        .in("status", [...OPEN_SERVICE])
        .neq("id", deliveryId)
      if (error) throw new Error(error.message)
      kept = holdingReturns((data ?? []) as OpenJob[])
    } catch (e) {
      return { alreadyClosed: false, waiting: false, lines, problems: [`could not check for an open tax return (${e instanceof Error ? e.message : String(e)}) — nothing was changed`] }
    }
  }
  const waiting = kept.length > 0
  const keptIds = new Set(kept.map((k) => k.id))
  // Unpaid invoices of a kept tax return's offer are not cancelled: while the return is pending, and — reported, not cancelled — when it is filed.
  const keptTokens = new Set<string>([...Array.from(keptOfferTokens(kept)), ...(p.protectOfferTokens ?? [])])

  // 1. the company's other open services
  try {
    const { data: open, error } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, service_type")
      .eq("account_id", accountId)
      .in("status", [...OPEN_SERVICE])
      .neq("id", deliveryId)
    if (error) throw new Error(error.message)
    const { deactivateSD } = await import("@/lib/operations/service-delivery")
    const cancelled: string[] = []
    for (const sd of (open ?? []) as Array<{ id: string; service_type: string }>) {
      if (keptIds.has(sd.id)) continue // the final tax return stays open (part C)
      const r = await deactivateSD({ delivery_id: sd.id, actor: "system:sd-closure", reason: "Company closed (closure job finished)", clear_renewal_date: true })
      if (r.success || r.outcome === "already_terminal") cancelled.push(sd.service_type)
      else fail(`could not cancel ${sd.service_type}`, r.error ?? r.outcome)
    }
    if (cancelled.length) lines.push(`Cancelled ${cancelled.length} other service${cancelled.length === 1 ? "" : "s"}: ${cancelled.join(", ")}`)
  } catch (e) {
    fail("could not cancel the company's other services", e)
  }

  // 2. pending deadlines
  try {
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    let q = supabaseAdmin.from("deadlines").update({ status: "Cancelled" }).eq("account_id", accountId).eq("status", "Pending")
    if (waiting) q = q.not("deadline_type", "ilike", "%tax%") // the final return's own deadline stays (part C)
    const { data, error } = await q.select("id")
    if (error) throw new Error(error.message)
    if (data?.length) lines.push(`Cancelled ${data.length} upcoming deadline${data.length === 1 ? "" : "s"}`)
  } catch (e) {
    fail("could not cancel the company's deadlines", e)
  }

  // 3. unpaid invoices — cancelled the way Finance's "Void" does it (production end-to-end test 2026-11-07: only `status` was set, so the
  //    invoice still read "Draft" and the client's copy still demanded the full amount): status AND invoice status, the numbering slot
  //    freed, the client's copy rebuilt, the before-state recorded so "Reactivate" can restore it exactly, a stale bank-feed suggestion cleared.
  try {
    const { data, error } = await supabaseAdmin
      .from("payments")
      .select("id, invoice_number, status, invoice_status, amount, amount_currency, amount_due, amount_paid, paid_date, credit_remaining, tranche_offer_token")
      .eq("account_id", accountId)
      .in("status", ["Pending", "Overdue"])
    if (error) throw new Error(error.message)
    const { capturePreVoidState } = await import("@/lib/billing/invoice-reactivate")
    const { syncTDInvoiceStatus } = await import("@/lib/portal/td-invoice")
    const { syncTDInvoiceMirror } = await import("@/lib/portal/td-invoice-mirror")
    const { logAction } = await import("@/lib/mcp/action-log")
    const cancelled: Array<{ amount: number | string | null; amount_currency: string | null }> = []
    const cancelledIds: string[] = []
    // Only a row with nothing received is cancelled. A part-paid invoice is left open and REPORTED (Finance's Void refuses it too: the money
    // received would sit on a cancelled invoice); an unused credit note is not an invoice; a row whose status column is stale is left alone.
    // The unpaid invoices of a kept tax return's offer are not touched at all (part C) — neither cancelled nor reported.
    const keptRows = ((data ?? []) as Array<Row & OpenPaymentRow & { tranche_offer_token?: string | null }>).filter((r) => belongsToKeptOffer(r, keptTokens))
    if (keptRows.length && waiting) lines.push(`${keptRows.length} unpaid invoice${keptRows.length === 1 ? "" : "s"} of the tax return's offer stay${keptRows.length === 1 ? "s" : ""} open`)
    // The return is filed and a part of its offer is still unpaid: money may be owed, so it is never cancelled behind staff's back.
    if (!waiting) for (const r of keptRows) problems.push(`invoice ${r.invoice_number || r.id} (a part of the filed tax return's offer) is still unpaid — it was NOT cancelled: collect it or void it by hand`)
    const classified = classifyOpenPayments(((data ?? []) as Array<Row & OpenPaymentRow & { tranche_offer_token?: string | null }>).filter((r) => !belongsToKeptOffer(r, keptTokens)))
    for (const p of classified.partPaid) {
      const cur = (p.amount_currency || "USD").toUpperCase()
      problems.push(`invoice ${p.invoice_number || p.id} is part-paid (${paidOf(p)} ${cur} received, ${owedOf(p)} ${cur} still owed) — it was NOT cancelled: settle or refund it by hand`)
    }
    if (classified.credits.length) lines.push(`${classified.credits.length} unused credit note${classified.credits.length === 1 ? "" : "s"} stay${classified.credits.length === 1 ? "s" : ""} on the account (a credit is not an invoice — not cancelled)`)
    for (const p of classified.cancel) {
      const label = p.invoice_number || p.id
      const before = capturePreVoidState(p as unknown as Parameters<typeof capturePreVoidState>[0])
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { data: voided, error: vErr } = await supabaseAdmin
        .from("payments")
        .update({ status: "Cancelled", invoice_status: "Cancelled", idempotency_key: null, updated_at: new Date().toISOString() })
        .eq("id", p.id)
        .in("status", ["Pending", "Overdue"]) // paid in the meantime → left alone
        .select("id")
      if (vErr) { fail(`could not cancel invoice ${label}`, vErr.message); continue }
      if (!voided?.length) continue
      cancelled.push(p)
      cancelledIds.push(p.id)
      try {
        await syncTDInvoiceStatus(p.id, "Cancelled")
        await syncTDInvoiceMirror(p.id)
      } catch (e) {
        fail(`invoice ${label} is cancelled but the client's copy of it could not be updated`, e)
      }
      logAction({
        actor: "system:sd-closure",
        action_type: "update",
        table_name: "payments",
        record_id: p.id,
        summary: `Invoice ${label} cancelled — the company was closed (closure job finished)`,
        // read back by Finance's Reactivate — keep the key name
        details: { pre_void_state: before, reason: "company-closed" },
      })
    }
    if (cancelledIds.length) {
      // an unconfirmed bank-feed suggestion must not keep pointing at a cancelled invoice (a confirmed match is left as it is)
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { error: fErr } = await supabaseAdmin.from("td_bank_feeds").update({ matched_payment_id: null, match_confidence: null, updated_at: new Date().toISOString() }).in("matched_payment_id", cancelledIds).neq("status", "matched")
      if (fErr) fail("a cancelled invoice still has a bank-feed suggestion pointing at it", fErr.message)
      const totals = Object.entries(money(cancelled)).map(([c, a]) => `${a} ${c}`).join(" + ")
      lines.push(`Cancelled ${cancelled.length} unpaid invoice${cancelled.length === 1 ? "" : "s"} (${totals})`)
    }
  } catch (e) {
    fail("could not cancel the company's unpaid invoices", e)
  }

  // 4. open to-dos: this job's own → Done, everything else → Cancelled. The job's own FOLLOW-UP cards from an earlier closing ("[CLOSURE] Remove
  //    RA on Harbor…") are real work nobody did yet: finishing the job again after a Go Back used to tick them Done (production test 2026-11-07).
  try {
    const { data: open, error } = await supabaseAdmin.from("tasks").select("id, delivery_id, task_title").eq("account_id", accountId).in("status", [...OPEN_TODO])
    if (error) throw new Error(error.message)
    const rows = (open ?? []) as Array<{ id: string; delivery_id: string | null; task_title: string | null }>
    const own = rows.filter((t) => t.delivery_id === deliveryId && !isClosureFollowUpTitle(t.task_title)).map((t) => t.id)
    const others = rows.filter((t) => t.delivery_id !== deliveryId && !(t.delivery_id && keptIds.has(t.delivery_id))).map((t) => t.id) // the final return's own to-dos stay (part C)
    const { updateTasksBulk } = await import("@/lib/operations/task")
    if (own.length) {
      const r = await updateTasksBulk({ ids: own, patch: { status: "Done" }, actor: "system:sd-closure", summary: `Auto-completed ${own.length} to-do(s) of the finished closure job` })
      if (!r.success) fail("could not complete the job's own to-dos", r.error ?? r.outcome)
    }
    if (others.length) {
      const r = await updateTasksBulk({ ids: others, patch: { status: "Cancelled" }, actor: "system:sd-closure", summary: `Cancelled ${others.length} open to-do(s) of the closed company` })
      if (!r.success) fail("could not cancel the company's other to-dos", r.error ?? r.outcome)
      else lines.push(`Cancelled ${others.length} open to-do${others.length === 1 ? "" : "s"} of the company`)
    }
  } catch (e) {
    fail("could not close the company's open to-dos", e)
  }

  // 5. the company itself (not again when it was already Closed). Held by a Tax Return still to be filed: it stays open, the portal stays on, and a
  //    marker note on the closure job says why (it is what the nightly jobs and the completion look for).
  let closed = false
  let stillWaiting = waiting
  let lateClose = false
  if (waiting) {
    try {
      const { data: have, error: hErr } = await (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any -- service_delivery_notes is not in the generated types yet
        .from("service_delivery_notes")
        .select("id, body")
        .eq("service_delivery_id", deliveryId)
        .ilike("body", CLOSING_MARKER_LIKE)
        .order("created_at", { ascending: true })
      if (hErr) throw new Error(hErr.message)
      // Only the NEWEST marker counts: a wait that was ended (or never written) gets a fresh note; a standing wait is not written twice.
      if (newestMarker((have ?? []) as Array<{ body: string | null }>) !== "waits") {
        const { error: nErr } = await (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any -- same
          .from("service_delivery_notes")
          .insert({ service_delivery_id: deliveryId, body: waitsNote(kept), author_name: "Closing step" })
        if (nErr) throw new Error(nErr.message)
      }
      lines.push(`The company stays open (portal on) until ${kept.map(returnLabel).join(", ")} ${kept.length === 1 ? "is" : "are"} filed — it closes by itself then`)

      // Lost wake-up guard: the return may have been filed while the cancellations above ran — its completion hook then found no note and did nothing.
      // Look again now that the note is written; if nothing holds the closing any more, complete it right here.
      const { data: nowOpen, error: rErr } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, service_type, status, stage")
        .eq("account_id", accountId)
        .in("status", [...OPEN_SERVICE])
        .neq("id", deliveryId)
      if (rErr) throw new Error(rErr.message)
      lateClose = holdingReturns((nowOpen ?? []) as OpenJob[]).length === 0
    } catch (e) {
      fail("the company was left open for its tax return but the reminder note could NOT be written (the nightly jobs will not know it is closing)", e)
    }
    if (lateClose) {
      const done = await completePendingCompanyClosure({ accountId })
      lines.push(...done.lines)
      problems.push(...done.problems)
      stillWaiting = done.waiting === true
    }
  } else if (!wasClosed) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      const { error } = await supabaseAdmin
        .from("accounts")
        .update({ status: "Closed", portal_account: false, portal_tier: "inactive", updated_at: new Date().toISOString() })
        .eq("id", accountId)
      if (error) throw new Error(error.message)
      closed = true
      lines.push("Account → Closed, portal deactivated")
    } catch (e) {
      fail("could NOT set the company to Closed", e)
    }
  }
  if (closed) {
    // The company is Closed: the wait (if there was one) is over. Without this note a company later brought back to Active would still look like it waits.
    try {
      await endClosingWait(deliveryId, "the company was closed")
    } catch (e) {
      fail("the closing's waiting note could not be ended", e)
    }
    try {
      const { syncContactTiersForAccount } = await import("@/lib/operations/sync-tier")
      await syncContactTiersForAccount(accountId, "system:sd-closure")
    } catch (e) {
      fail("the company is Closed but its people's portal level could not be recomputed", e)
    }

  }
  if ((closed || waiting) && !p.skipFollowUps) {
    // 6. the follow-up to-dos, in their own block: a failure here is reported as such and cannot hide the steps above. They are about the closure JOB
    //    (the registered agent, the lease), not about the company's status, so a held closing creates them too — once (a second finish adds none).
    try {
      const { count, error: lErr } = await supabaseAdmin.from("lease_agreements").select("id", { count: "exact", head: true }).eq("account_id", accountId).in("status", [...LIVE_LEASE])
      if (lErr) throw new Error(lErr.message)
      const { data: haveCards, error: cErr } = await supabaseAdmin.from("tasks").select("task_title").eq("delivery_id", deliveryId)
      if (cErr) throw new Error(cErr.message)
      const haveTitles = new Set(((haveCards ?? []) as Array<{ task_title: string | null }>).map((t) => t.task_title))
      const cards = buildClosureFollowUpCards(jobTasks, wrapUpStepExists, (count ?? 0) > 0).filter((c) => !haveTitles.has(c.task_title))
      if (cards.length) {
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { error } = await supabaseAdmin.from("tasks").insert(
          cards.map((c) => ({
            task_title: c.task_title,
            description: c.description,
            assigned_to: "Luca",
            priority: c.priority,
            category: c.category,
            status: "To Do" as const,
            account_id: accountId,
            delivery_id: deliveryId,
            created_by: "System",
          })),
        )
        if (error) throw new Error(error.message)
        lines.push(`Created ${cards.length} closure to-do${cards.length === 1 ? "" : "s"}: ${cards.map((c) => c.task_title.replace("[CLOSURE] ", "")).join("; ")}`)
      }
    } catch (e) {
      fail("the closure follow-up to-dos were NOT created", e)
    }
  }

  return { alreadyClosed: wasClosed, waiting: stillWaiting, lines, problems }
}

/**
 * End a company's wait, when it has one: writes the "CLOSING WAIT ENDED" note on the closure job, but only if the newest marker there says it waits.
 * Called when the company is Closed and when the job is finished WITHOUT waiting ("skip company close"). Returns whether a wait was ended. THROWS on an error.
 */
export async function endClosingWait(jobId: string, reason: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_notes is not in the generated types yet (lib/job-notes/read.ts)
  const { data, error } = await (supabaseAdmin as any).from("service_delivery_notes").select("body").eq("service_delivery_id", jobId).ilike("body", CLOSING_MARKER_LIKE).order("created_at", { ascending: true })
  if (error) throw new Error(error.message)
  if (newestMarker((data ?? []) as Array<{ body: string | null }>) !== "waits") return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same
  const { error: iErr } = await (supabaseAdmin as any).from("service_delivery_notes").insert({ service_delivery_id: jobId, body: endedNote(reason), author_name: "Closing step" })
  if (iErr) throw new Error(iErr.message)
  return true
}

/** A durable note on the closure job — where staff look — for a closing that did not fully work after its tax return (the screen warning of an automatic move vanishes). Never throws. */
async function noteClosureProblem(jobId: string, problems: string[]): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_notes is not in the generated types yet
    await (supabaseAdmin as any).from("service_delivery_notes").insert({ service_delivery_id: jobId, body: `CLOSURE PROBLEM: completing the company's closing after its final tax return did not fully work — ${problems.join(" · ")}`, author_name: "Closing step" })
  } catch {
    /* a note must never fail the move */
  }
}

/**
 * Finish a closing that was HELD for a final tax return (dev job 0a60f416, part C). Called when a Tax Return job reaches "TR Filed" or is cancelled, and by the
 * nightly sweep (app/api/cron/complete-held-closings) for every path that does not call it (a return cancelled or removed from the tracker, a failed earlier try).
 *
 * It does nothing at all unless a closure job of the company is STILL holding it: finished at "Closing" with its newest marker saying "waits"
 * (lib/closure/pending-return.ts). Going back, cancelling the job, finishing again without waiting ("skip company close") or an earlier closing all end the wait,
 * so a tax return finishing in normal life, or a company brought back to Active, is never closed by it. When no Tax Return of the company is still open the same
 * closing runs (idempotent, minus the follow-up to-dos created when the job finished): the company becomes Closed, the portal goes off. A problem is written on
 * the closure job as well as returned. Never throws.
 */
export async function completePendingCompanyClosure(p: { accountId: string }): Promise<CompanyClosureResult> {
  const none: CompanyClosureResult = { alreadyClosed: false, waiting: false, lines: [], problems: [] }
  let closureJobId: string | null = null
  try {
    const { data: acct, error: aErr } = await supabaseAdmin.from("accounts").select("status").eq("id", p.accountId).maybeSingle()
    if (aErr) throw new Error(aErr.message)
    if (!acct || String((acct as Row).status ?? "").toLowerCase() === "closed") return none

    const { data: jobs, error: jErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, service_type, status, stage, service_name, source_offer_token")
      .eq("account_id", p.accountId)
    if (jErr) throw new Error(jErr.message)
    const all = (jobs ?? []) as Array<OpenJob & { service_type: string; status: string | null }>
    const closureJobs = all.filter((j) => j.service_type === "Company Closure")
    if (closureJobs.length === 0) return none

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_notes is not in the generated types yet (lib/job-notes/read.ts)
    const { data: notes, error: nErr } = await (supabaseAdmin as any).from("service_delivery_notes").select("service_delivery_id, body").in("service_delivery_id", closureJobs.map((j) => j.id)).ilike("body", CLOSING_MARKER_LIKE).order("created_at", { ascending: true })
    if (nErr) throw new Error(nErr.message)
    const byJob = new Map<string, Array<{ body: string | null }>>()
    for (const n of (notes ?? []) as Array<{ service_delivery_id: string; body: string | null }>) byJob.set(n.service_delivery_id, [...(byJob.get(n.service_delivery_id) ?? []), { body: n.body }])
    const waitingJob = closureJobs.find((j) => isWaitingClosureJob(j, byJob.get(j.id) ?? []))
    if (!waitingJob) return none // nobody asked this company to wait (or the wait was ended) — a tax return finishing here closes nothing
    closureJobId = waitingJob.id

    const stillOpen = holdingReturns(all.filter((j) => (OPEN_SERVICE as readonly string[]).includes(String(j.status ?? ""))))
    if (stillOpen.length > 0) {
      return { ...none, waiting: true, lines: [`The company is still waiting for ${stillOpen.map(returnLabel).join(", ")} before it closes`] }
    }

    // the offers of every Tax Return job of the company — their unpaid invoices are reported, not cancelled
    const protectOfferTokens = Array.from(keptOfferTokens(all.filter((j) => TAX_RETURN_SERVICES.includes(j.service_type))))
    const done = await applyCompanyClosure({ accountId: p.accountId, deliveryId: waitingJob.id, wrapUpStepExists: false, skipFollowUps: true, protectOfferTokens })
    if (done.problems.length > 0) await noteClosureProblem(waitingJob.id, done.problems)
    return { ...done, lines: ["The final tax return is done — the company's closing is completed now", ...done.lines] }
  } catch (e) {
    const problem = `could not complete the company's closing after its tax return: ${e instanceof Error ? e.message : String(e)}`
    if (closureJobId) await noteClosureProblem(closureJobId, [problem])
    return { ...none, problems: [problem] }
  }
}
