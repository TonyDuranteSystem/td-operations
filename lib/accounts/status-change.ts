/**
 * A company's status changed (Storage check Phase 3, dev job f855295a; Antonio 2026-10-17: "all notifications must go in the Calendar").
 *
 * A database trigger leaves one `account_status_events` row for every change of `accounts.status`, whichever screen or tool made it.
 * `processAccountStatusEvents` (run by /api/cron/account-status-events) turns each row into ONE staff-only note in the Calendar's
 * What's New, saying in plain words what that status means for the client's portal and the company's storage. It changes nothing else.
 *
 * Facts it states (verified in the code on 2026-10-17): the client portal lists only Active and Suspended companies
 * (lib/portal/queries.ts getPortalAccounts) — Suspended with a banner and limited access; Offboarding, Closed, Cancelled and Delinquent are
 * hidden from the portal. Nothing in this step deletes or moves anything in storage.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export type StatusNote = { notify: false; reason: string } | { notify: true; headline: string; lines: string[] }

const HIDDEN_FROM_PORTAL = new Set(["Offboarding", "Closed", "Cancelled", "Delinquent"])

/** Pure: what, if anything, staff should be told about this change. */
export function describeStatusChange(oldStatus: string | null, newStatus: string | null, ctx: { hasStorage: boolean; /** the automatic step that brings old documents back is switched on (STORE_REACTIVATION) */ autoBringBack?: boolean }): StatusNote {
  if (!newStatus || oldStatus === newStatus) return { notify: false, reason: "no change" }
  const storageLine = ctx.hasStorage ? "Its storage is kept; nothing was deleted or moved." : "It has no storage."
  if (newStatus === "Suspended") {
    return { notify: true, headline: "moved to Suspended", lines: ["In the client portal the client still sees the company, with a banner and limited access.", storageLine] }
  }
  if (HIDDEN_FROM_PORTAL.has(newStatus)) {
    return { notify: true, headline: `moved to ${newStatus}`, lines: ["The client no longer sees this company in the portal.", storageLine] }
  }
  if (newStatus === "Active") {
    if (oldStatus === "Suspended") {
      return { notify: true, headline: "is Active again", lines: ["The portal banner is gone; the client has full access again.", storageLine] }
    }
    if (oldStatus && HIDDEN_FROM_PORTAL.has(oldStatus)) {
      return {
        notify: true,
        headline: "was reactivated",
        lines: [
          "The client sees the company in the portal again.",
          ctx.hasStorage ? "Its storage is still there." : ctx.autoBringBack ? "It has no storage yet — the system is bringing its old documents back in; each step is noted here." : "It has NO storage yet — its old documents still have to be brought in.",
        ],
      }
    }
    return { notify: false, reason: "not a change that affects the portal or storage" }
  }
  return { notify: false, reason: "not a change that affects the portal or storage" }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- account_status_events is not in the generated types yet
const db = () => supabaseAdmin as any

export interface StatusRunResult { processed: number; notified: number; skipped: number; failed: number; tableMissing?: boolean }

export async function processAccountStatusEvents(opts: { budgetMs: number }): Promise<StatusRunResult> {
  const t0 = Date.now()
  const out: StatusRunResult = { processed: 0, notified: 0, skipped: 0, failed: 0 }
  const { data: events, error } = await db().from("account_status_events").select("id, account_id, old_status, new_status").is("handled_at", null).order("created_at", { ascending: true }).limit(50)
  if (error) { out.tableMissing = true; return out } // the table is created by a migration; before it exists there is nothing to do
  const { emitAccountStatusEvent } = await import("@/lib/portal/chat-events")
  for (const ev of (events ?? []) as Array<{ id: string; account_id: string; old_status: string | null; new_status: string | null }>) {
    if (Date.now() - t0 > opts.budgetMs) break
    out.processed++
    try {
      const { data: acct } = await db().from("accounts").select("company_name").eq("id", ev.account_id).maybeSingle()
      const { count } = await db().from("store_owners").select("id", { count: "exact", head: true }).eq("account_id", ev.account_id).eq("kind", "company")
      const { reactivationAllowed } = await import("@/lib/crm-store/go-live")
      const note = describeStatusChange(ev.old_status, ev.new_status, { hasStorage: (count ?? 0) > 0, autoBringBack: reactivationAllowed() })
      if ("reason" in note) {
        await db().from("account_status_events").update({ handled_at: new Date().toISOString(), handled_note: `skipped: ${note.reason}` }).eq("id", ev.id)
        out.skipped++
        continue
      }
      const r = await emitAccountStatusEvent({ eventId: ev.id, accountId: ev.account_id, companyName: (acct?.company_name as string | null) ?? null, headline: note.headline, lines: note.lines })
      if (!r.emitted && r.reason !== "already_emitted") { out.failed++; continue } // left unhandled: tried again next run
      await db().from("account_status_events").update({ handled_at: new Date().toISOString(), handled_note: `noted: ${note.headline}` }).eq("id", ev.id)
      out.notified++
    } catch {
      out.failed++
    }
  }
  return out
}
