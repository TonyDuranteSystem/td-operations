/**
 * Referral backlog reconciler — applies the LIVE auto-credit rules to historic
 * converted-but-uncredited referrals (the pre-2026-06-25 backlog, when the
 * offer-referrer path only created a manual task instead of issuing the credit).
 *
 * Decision logic is pure (`decideBacklogReferral`, lib/operations/referral.ts):
 *  - duplicate of an already-credited sibling → cancel (prevents double-pay)
 *  - referrer resolves to exactly one account + positive amount → credit (USD)
 *  - anything ambiguous → reported as "needs decision", NEVER guessed
 *
 * Dry-run by default; `apply: true` executes. Crediting is idempotent per
 * referral (issueReferralCreditNote, idempotency_key='referral-credit:<id>'),
 * so re-running can never double-pay. When a referral is credited or cancelled,
 * its stale "Process referral commission" task (status 'To Do') is closed.
 *
 * Invoked from the admin-only route POST /api/referral/reconcile-backlog
 * (Referrals page → "Reconcile backlog"). It must run server-side on the
 * deployed app — local processes are blocked from production by the
 * supabase-admin environment guard, by design.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  decideBacklogReferral,
  issueReferralCreditNote,
  type BacklogReferralInput,
} from "@/lib/operations/referral"

export interface BacklogReportRow {
  referralId: string
  referrerName: string | null
  referredName: string | null
  amount: number | null
  currency: string | null
  createdAt: string | null
  decision: "credit" | "cancel_duplicate" | "needs_decision"
  detail: string
  applied: boolean
  error?: string
}

export interface BacklogReport {
  apply: boolean
  rows: BacklogReportRow[]
  summary: { credit: number; cancel: number; needsDecision: number; errors: number }
}

type ReferralRowDb = BacklogReferralInput & {
  commission_currency: string | null
  created_at: string | null
  notes: string | null
  referrer: { full_name: string | null } | null
  referrer_account: { company_name: string | null } | null
}

const SKIP_DETAIL: Record<string, string> = {
  no_referrer: "No referrer recorded on the row — identify the referrer first",
  no_account: "Referrer has no linked company — link one, or pay out manually",
  multiple_accounts: "Referrer owns several companies — choose which one gets the credit",
  no_amount: "No commission amount recorded — set the amount first",
}

export async function reconcileReferralBacklog(
  opts: { apply: boolean },
  supabase: SupabaseClient,
): Promise<BacklogReport> {
  // 1. The backlog: converted, never credited, real (non-test) rows.
  const { data: backlogRaw } = await supabase
    .from("referrals")
    .select(`
      id, referrer_contact_id, referrer_account_id, referred_contact_id,
      referred_account_id, referred_lead_id, referred_name, status,
      commission_amount, credited_amount, commission_currency, created_at, notes,
      referrer:contacts!referrals_referrer_contact_id_fkey(full_name),
      referrer_account:accounts!referrals_referrer_account_id_fkey(company_name)
    `)
    .eq("status", "converted")
    .eq("is_test", false)
    .order("created_at", { ascending: true })
  const backlog = ((backlogRaw ?? []) as unknown as ReferralRowDb[]).filter(
    (r) => !(Number(r.credited_amount) > 0),
  )
  if (backlog.length === 0) {
    return { apply: opts.apply, rows: [], summary: { credit: 0, cancel: 0, needsDecision: 0, errors: 0 } }
  }

  // 2. Context, batched: every non-cancelled referral by the same referrers
  //    (for duplicate detection) + the referrer contacts' linked accounts.
  const contactIds = Array.from(new Set(backlog.map((r) => r.referrer_contact_id).filter(Boolean))) as string[]
  const accountIds = Array.from(new Set(backlog.map((r) => r.referrer_account_id).filter(Boolean))) as string[]

  const orParts = [
    contactIds.length ? `referrer_contact_id.in.(${contactIds.join(",")})` : null,
    accountIds.length ? `referrer_account_id.in.(${accountIds.join(",")})` : null,
  ].filter(Boolean)
  const { data: siblingsRaw } = await supabase
    .from("referrals")
    .select("id, referrer_contact_id, referrer_account_id, referred_contact_id, referred_account_id, referred_lead_id, referred_name, status, commission_amount, credited_amount")
    .or(orParts.join(","))
    .neq("status", "cancelled")
  const siblings = (siblingsRaw ?? []) as BacklogReferralInput[]

  const linksByContact = new Map<string, string[]>()
  if (contactIds.length) {
    const { data: links } = await supabase
      .from("account_contacts")
      .select("contact_id, account_id")
      .in("contact_id", contactIds)
    for (const l of (links ?? []) as Array<{ contact_id: string; account_id: string }>) {
      const arr = linksByContact.get(l.contact_id) ?? []
      arr.push(l.account_id)
      linksByContact.set(l.contact_id, arr)
    }
  }

  // 3. Decide + (optionally) execute, row by row.
  const rows: BacklogReportRow[] = []
  const summary = { credit: 0, cancel: 0, needsDecision: 0, errors: 0 }

  for (const r of backlog) {
    const siblingReferrals = siblings.filter(
      (s) =>
        s.id !== r.id &&
        ((r.referrer_contact_id && s.referrer_contact_id === r.referrer_contact_id) ||
          (r.referrer_account_id && s.referrer_account_id === r.referrer_account_id)),
    )
    const referrerAccountIds = r.referrer_account_id
      ? [r.referrer_account_id]
      : (r.referrer_contact_id ? (linksByContact.get(r.referrer_contact_id) ?? []) : [])

    const decision = decideBacklogReferral(r, { siblingReferrals, referrerAccountIds })
    const referrerName = r.referrer?.full_name ?? r.referrer_account?.company_name ?? null

    const row: BacklogReportRow = {
      referralId: r.id,
      referrerName,
      referredName: r.referred_name,
      amount: r.commission_amount,
      currency: r.commission_currency,
      createdAt: r.created_at,
      decision: decision.action === "skip" ? "needs_decision" : decision.action,
      detail:
        decision.action === "credit"
          ? `Issue $${decision.amount} USD credit note to the referrer's company (recorded figure taken as USD, no FX)`
          : decision.action === "cancel_duplicate"
            ? `Duplicate of already-credited referral ${decision.duplicateOfId.slice(0, 8)} — cancel (crediting would double-pay)`
            : SKIP_DETAIL[decision.reason] ?? decision.reason,
      applied: false,
    }

    if (decision.action === "credit") summary.credit++
    else if (decision.action === "cancel_duplicate") summary.cancel++
    else summary.needsDecision++

    if (opts.apply && decision.action === "credit") {
      try {
        await issueReferralCreditNote(
          {
            referralId: r.id,
            referrerAccountId: decision.accountId,
            referrerContactId: r.referrer_contact_id,
            amount: decision.amount,
            currency: "USD",
            description: `Referral reward — 10% credit (${r.referred_name ?? "referred client"})`,
          },
          supabase,
        )
        // Attribute the row to the credited account too (it was contact-keyed).
        if (!r.referrer_account_id) {
          await supabase.from("referrals").update({ referrer_account_id: decision.accountId }).eq("id", r.id)
        }
        await closeCommissionTask(r.referred_name, supabase)
        row.applied = true
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e)
        summary.errors++
      }
    }

    if (opts.apply && decision.action === "cancel_duplicate") {
      try {
        await supabase
          .from("referrals")
          .update({
            status: "cancelled",
            notes: `${r.notes ? `${r.notes} — ` : ""}Cancelled by backlog reconciler: duplicate of referral ${decision.duplicateOfId} (already credited).`,
          })
          .eq("id", r.id)
          .eq("status", "converted") // guard: don't clobber a row that moved meanwhile
        await closeCommissionTask(r.referred_name, supabase)
        row.applied = true
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e)
        summary.errors++
      }
    }

    rows.push(row)
  }

  return { apply: opts.apply, rows, summary }
}

/** Close the stale "Process referral commission — X → <referred>" task, if any. */
async function closeCommissionTask(referredName: string | null, supabase: SupabaseClient): Promise<void> {
  const name = (referredName ?? "").trim()
  if (!name) return
  await supabase
    .from("tasks")
    .update({ status: "Done", completed_date: new Date().toISOString() })
    .eq("status", "To Do")
    .like("task_title", "Process referral commission —%")
    .ilike("task_title", `%${name}%`)
}
