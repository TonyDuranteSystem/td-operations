/**
 * Company Closure — what "Closing" does to the company, and the facts the ask-first question shows before it does it
 * (Company Closure Part C, dev job a6bbea09; replaces the inline block "14. Company Closure" of lib/service-delivery.ts).
 *
 * What the job's last step does when a closure job reaches "Closing":
 *   1. cancels every OTHER open service of the company — active, ON HOLD and BLOCKED ones (only active ones used to be cancelled, so
 *      a held tax return or a blocked renewal lived on for a company that no longer exists) — through `deactivateSD`, which also
 *      stamps the end date and clears a renewal date so the nightly cron does not re-create it;
 *   2. cancels the company's pending deadlines (a renewal reminder for a closed company is noise);
 *   3. cancels the company's unpaid invoices (Pending / Overdue) — the same default the manual "Closed" status change has always had,
 *      done the way Finance's Void does it (both status columns, the client's copy rebuilt, the before-state recorded for "Reactivate");
 *      the question shows them first so staff can collect before saying yes. Paid invoices are never touched;
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

const OPEN_SERVICE = ["active", "on_hold", "blocked"] as const
const OPEN_TODO = ["To Do", "In Progress", "Waiting"] as const
const LIVE_LEASE = ["signed", "viewed", "sent"] as const

export interface CompanyClosureResult {
  alreadyClosed: boolean
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

/** The text after "CHECK:" in the latest note the closure wizard left on the job when the client wrote a different company. */
export function checkNoteFrom(notes: ReadonlyArray<{ body: string | null }>): string | null {
  for (const n of notes) {
    const i = (n.body ?? "").indexOf("CHECK:")
    if (i >= 0) return (n.body ?? "").slice(i + "CHECK:".length).trim() || null
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
    supabaseAdmin.from("service_deliveries").select("service_type, status").eq("account_id", accountId).in("status", [...OPEN_SERVICE]).neq("id", serviceDeliveryId),
    supabaseAdmin.from("deadlines").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("status", "Pending"),
    supabaseAdmin.from("payments").select("amount, amount_currency").eq("account_id", accountId).in("status", ["Pending", "Overdue"]),
    supabaseAdmin.from("tasks").select("id, delivery_id").eq("account_id", accountId).in("status", [...OPEN_TODO]),
    supabaseAdmin.from("account_contacts").select("contact_id", { count: "exact", head: true }).eq("account_id", accountId).is("ended_at", null),
    supabaseAdmin.from("lease_agreements").select("id", { count: "exact", head: true }).eq("account_id", accountId).in("status", [...LIVE_LEASE]),
    supabaseAdmin.from("service_delivery_notes").select("body").eq("service_delivery_id", serviceDeliveryId).ilike("body", "%CHECK:%").order("created_at", { ascending: false }).limit(5),
  ])
  for (const [name, r] of Object.entries({ services, deadlines, payments, tasks, members, leases, notes })) {
    if (r.error) throw new Error(`closing brief: could not read ${name}: ${r.error.message}`)
  }

  const unpaidRows = (payments.data ?? []) as Array<{ amount: number | string | null; amount_currency: string | null }>
  return {
    companyName: (acct as Row).company_name as string,
    alreadyClosed: String((acct as Row).status ?? "").toLowerCase() === "closed",
    openServices: ((services.data ?? []) as Array<{ service_type: string; status: string }>).map((s) => ({ type: s.service_type, status: s.status })),
    pendingDeadlines: deadlines.count ?? 0,
    unpaid: { count: unpaidRows.length, totals: money(unpaidRows) },
    openTasks: ((tasks.data ?? []) as Array<{ delivery_id: string | null }>).filter((t) => t.delivery_id !== serviceDeliveryId).length,
    members: members.count ?? 0,
    hasLease: (leases.count ?? 0) > 0,
    checkNote: checkNoteFrom((notes.data ?? []) as Array<{ body: string | null }>),
  }
}

/**
 * Close the company a finished closure job belongs to. Never throws for a failed step — it reports it in `problems`.
 * @param wrapUpStepExists whether the Company Closure step list has the (dormant) "Wrap-up" step — passed on to the follow-up to-dos.
 */
export async function applyCompanyClosure(p: { accountId: string; deliveryId: string; wrapUpStepExists: boolean }): Promise<CompanyClosureResult> {
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
    const { data, error } = await supabaseAdmin.from("deadlines").update({ status: "Cancelled" }).eq("account_id", accountId).eq("status", "Pending").select("id")
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
      .select("id, invoice_number, status, invoice_status, amount, amount_currency, amount_due, amount_paid, paid_date, credit_remaining")
      .eq("account_id", accountId)
      .in("status", ["Pending", "Overdue"])
    if (error) throw new Error(error.message)
    const { capturePreVoidState } = await import("@/lib/billing/invoice-reactivate")
    const { syncTDInvoiceStatus } = await import("@/lib/portal/td-invoice")
    const { syncTDInvoiceMirror } = await import("@/lib/portal/td-invoice-mirror")
    const { logAction } = await import("@/lib/mcp/action-log")
    const cancelled: Array<{ amount: number | string | null; amount_currency: string | null }> = []
    const cancelledIds: string[] = []
    for (const p of (data ?? []) as Array<Row & { id: string; invoice_number: string | null; invoice_status: string | null; amount: number | string | null; amount_currency: string | null }>) {
      if (p.invoice_status === "Credit") continue // a credit note is not voided like an invoice (Finance refuses it too)
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
    const others = rows.filter((t) => t.delivery_id !== deliveryId).map((t) => t.id)
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

  // 5. the company itself (not again when it was already Closed)
  let closed = false
  if (!wasClosed) {
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
    try {
      const { syncContactTiersForAccount } = await import("@/lib/operations/sync-tier")
      await syncContactTiersForAccount(accountId, "system:sd-closure")
    } catch (e) {
      fail("the company is Closed but its people's portal level could not be recomputed", e)
    }

    // 6. the follow-up to-dos, in their own block: a failure here is reported as such and cannot hide the steps above
    try {
      const { count, error: lErr } = await supabaseAdmin.from("lease_agreements").select("id", { count: "exact", head: true }).eq("account_id", accountId).in("status", [...LIVE_LEASE])
      if (lErr) throw new Error(lErr.message)
      const cards = buildClosureFollowUpCards(jobTasks, wrapUpStepExists, (count ?? 0) > 0)
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

  return { alreadyClosed: wasClosed, lines, problems }
}
