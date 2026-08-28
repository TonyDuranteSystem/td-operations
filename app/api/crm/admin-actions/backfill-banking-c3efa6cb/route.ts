/**
 * ONE-OFF backfill for dev job c3efa6cb (2026-08-28).
 *
 * At least 3 distinct ways an account's EIN could get recorded skipped
 * seeding its banking-application record, so the banking-wizard staff
 * notification (What's New note + Notification Center card) had nothing to
 * key off of and silently no-op'd. This route repairs the exact set of real
 * accounts confirmed affected — see dev job c3efa6cb's progress log for the
 * full investigation.
 *
 * For every (account, provider) pair below:
 *   1. getOrCreateBankingSubmission() — the same shared helper the fixed
 *      code paths now use. Never sends anything client-facing.
 *   2. If `alreadySubmitted`, pull the REAL submitted answers from
 *      wizard_progress (the canonical, always-safe copy — see
 *      lib/operations/banking-submission.ts's header) and mark the row
 *      completed, so it isn't left looking like a blank, unfilled
 *      application in staff review tools.
 *   3. If `alreadySubmitted && !alreadyResolved`, raise the catch-up staff
 *      alert now — worded to make clear this happened in the past, not
 *      today. Skipped entirely for the one pair staff already resolved
 *      manually (Aces Marketing Solutions / Payset), so as not to re-flag
 *      something already closed.
 *
 * Staff-only. Supports ?dry_run=true to preview without writing anything.
 * Safe to run more than once — every step is idempotent (the shared helper,
 * the wizard_progress read, and both emit functions all no-op on a repeat).
 */

import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getOrCreateBankingSubmission } from "@/lib/operations/banking-submission"

interface BackfillEntry {
  accountId: string
  companyName: string
  provider: "relay" | "payset"
  alreadySubmitted: boolean
  alreadyResolved?: boolean
}

const PLAN: BackfillEntry[] = [
  // ── 9 real, unreviewed submissions — get real data + a catch-up alert ──
  { accountId: "3e1f0473-418a-4ea5-8a56-f7b76ec894b9", companyName: "Automatiko LLC", provider: "payset", alreadySubmitted: true },
  { accountId: "792ad518-f309-4e06-b8a8-134bd8d969f2", companyName: "BRIXEL LLC", provider: "relay", alreadySubmitted: true },
  { accountId: "b9f81136-119d-435c-80eb-e2f838626641", companyName: "LC Marketing Consulting LLC", provider: "payset", alreadySubmitted: true },
  { accountId: "7898b4df-5fed-45fb-b31b-13134320e711", companyName: "MDL Advisory LLC", provider: "payset", alreadySubmitted: true },
  { accountId: "7898b4df-5fed-45fb-b31b-13134320e711", companyName: "MDL Advisory LLC", provider: "relay", alreadySubmitted: true },
  { accountId: "527a4363-8161-4047-b818-ad14149fdd59", companyName: "Outriders LLC", provider: "payset", alreadySubmitted: true },
  { accountId: "527a4363-8161-4047-b818-ad14149fdd59", companyName: "Outriders LLC", provider: "relay", alreadySubmitted: true },
  { accountId: "f9e9eb2e-4b8f-44f3-92f1-fbf00682d87a", companyName: "Stay Legit LLC", provider: "relay", alreadySubmitted: true },
  { accountId: "5e7a82fe-1b4b-4399-afcd-dd0d4f6d7c3a", companyName: "Aces Marketing Solutions LLC", provider: "relay", alreadySubmitted: true },
  // ── 1 already resolved by staff — silent backfill only, no alert ──
  { accountId: "5e7a82fe-1b4b-4399-afcd-dd0d4f6d7c3a", companyName: "Aces Marketing Solutions LLC", provider: "payset", alreadySubmitted: true, alreadyResolved: true },
  // ── 9 companies, nothing submitted yet — silent empty seed, both providers ──
  ...(["05cabe84-3221-4ccb-b204-6c1c6feb2cf9|ACE Marketing Group LLC", "0bfb51ad-8bd7-410b-9872-d11132d120f5|Luvain LLC", "12dadc46-e431-4d11-9fe0-5c561d38737a|AI Venture Labs LLC", "169b9dcf-965e-41c8-9f87-ae49fa731a8b|E-commerce Empire New York LLC", "2d5f913d-d139-444b-85e1-3750b3f0f5d0|DoctorGut LLC", "49c640c8-5758-40df-a17d-2045df852155|DOM Consulting LLC", "866f6cad-a73d-4152-be87-c2ca2e8807eb|Art of Profit Academy LLC", "bb34d821-ae8f-43a3-abc9-a2902b2665cb|Numero Uno Social LLC", "db3f20dd-47e8-431e-95d6-bb3c7af31071|Eloura LLC"] as const)
    .flatMap((entry) => {
      const [accountId, companyName] = entry.split("|")
      return (["relay", "payset"] as const).map((provider) => ({ accountId, companyName, provider, alreadySubmitted: false }))
    }),
]

function providerLabel(provider: "relay" | "payset"): string {
  return provider === "relay" ? "Relay (USD)" : "Payset (EUR)"
}

export async function POST(req: NextRequest) {
  // One-off backfill: allow either a real staff session OR the same
  // CRON_SECRET bearer token every scheduled job already authenticates
  // with (app/api/cron/*/route.ts) — this route runs exactly once, right
  // after this fix's own deploy, with no staff browser session available
  // to invoke it. Mirrors the precedent already used for the Slack-archive
  // one-off production run.
  const authHeader = req.headers.get("authorization")
  const hasCronSecret = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`
  if (!hasCronSecret) {
    const denied = await requireStaffRoute()
    if (denied) return denied
  }

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true"
  const results: Array<Record<string, unknown>> = []

  for (const entry of PLAN) {
    const step: Record<string, unknown> = { account: entry.companyName, provider: entry.provider }
    try {
      if (dryRun) {
        results.push({ ...step, dry_run: true, would: entry.alreadySubmitted ? (entry.alreadyResolved ? "seed + mark completed, no alert" : "seed + mark completed + catch-up alert") : "seed as pending, no alert" })
        continue
      }

      const created = await getOrCreateBankingSubmission({ accountId: entry.accountId, provider: entry.provider })
      if (created.outcome === "error") {
        step.error = created.message
        results.push(step)
        continue
      }
      step.banking_submission_id = created.record.id
      step.row_created = created.record.created

      if (!entry.alreadySubmitted) {
        step.action = "seeded_pending"
        results.push(step)
        continue
      }

      // Pull the client's REAL submitted answers — always safe, written at
      // submission time regardless of whether this row existed yet.
      const { data: progress } = await supabaseAdmin
        .from("wizard_progress")
        .select("data, updated_at")
        .eq("account_id", entry.accountId)
        .eq("wizard_type", entry.provider === "relay" ? "banking_relay" : "banking_payset")
        .eq("status", "submitted")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      await supabaseAdmin
        .from("banking_submissions")
        .update({ submitted_data: progress?.data ?? null, status: "completed", updated_at: new Date().toISOString() })
        .eq("id", created.record.id)
      step.marked_completed = true
      step.real_submission_date = progress?.updated_at ?? null

      if (entry.alreadyResolved) {
        step.action = "silent_backfill_already_resolved"
        results.push(step)
        continue
      }

      const { data: contactLink } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id")
        .eq("account_id", entry.accountId)
        .limit(1)
        .maybeSingle()

      const submittedDate = progress?.updated_at ? new Date(progress.updated_at).toISOString().slice(0, 10) : "an earlier date"
      const { emitClientChatEvent } = await import("@/lib/portal/chat-events")
      const noteResult = await emitClientChatEvent({
        account_id: entry.accountId,
        contact_id: contactLink?.contact_id ?? null,
        topic: "Banking",
        message: `Client submitted a ${providerLabel(entry.provider)} banking application via the portal wizard on ${submittedDate}. (Internal alert added retroactively — a setup gap silently blocked it at the time. See dev job c3efa6cb.)`,
        source: { table: "banking_submissions", id: created.record.id },
        event_kind: "banking_wizard_submitted",
      })
      step.whats_new_note = noteResult

      const { emitActionNeeded } = await import("@/lib/notifications/act-event")
      const cardResult = await emitActionNeeded({
        event: entry.provider === "relay" ? "banking_wizard_submitted_relay" : "banking_wizard_submitted_payset",
        account_id: entry.accountId,
        contact_id: contactLink?.contact_id ?? null,
        source_ref: `banking_submissions:${created.record.id}`,
      })
      step.notification_card = cardResult
      step.action = "catch_up_alert_raised"
      results.push(step)
    } catch (e) {
      step.error = e instanceof Error ? e.message : String(e)
      results.push(step)
    }
  }

  return NextResponse.json({ success: true, dry_run: dryRun, total: PLAN.length, results })
}
