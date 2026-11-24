/**
 * CRON: Payment-plan referrer/partner reward — issued automatically when the whole plan is paid.
 *
 * Runs every 15 minutes. Finds payment-plan offers carrying a referrer or managed partner, not yet released, and
 * checks whether the whole plan is NOW genuinely settled in real cash (every part Paid AND the money received).
 *
 * ⛔ CHANGED 2026-11-23 (dev job e71d786c, Antonio: "the referrer will get the reward after all payments are done").
 * Until then this only dropped a note in the account's What's New feed pointing staff at the "Release commission"
 * button and NEVER released anything. Now, the first time a deal qualifies:
 *   - a REFERRER (a real client/company, not a typed name) → the reward is issued by the same release the button uses
 *     (`releasePlanCommission`), and a staff note says so;
 *   - a managed PARTNER, a typed-name referrer, or the switch `PLAN_REFERRER_AUTO_RELEASE` set to off → the old note
 *     for a person to act on;
 *   - every invoice Paid but the money not confirmed on all of them (the strict gate's known gap) → nothing is paid,
 *     a note tells staff to check the bank and release by hand;
 *   - an automatic attempt that fails → ONE staff note, and no further automatic attempt for that deal.
 * The per-deal logic is in `lib/notifications/plan-referrer-sweep.ts`; the pure decision is
 * `decidePlanReferrerAction` (`lib/notifications/plan-referrer-notify.ts`).
 *
 * WHY A SWEEP, NOT A HOOK ON THE MONEY-WRITER: see the doc comment on lib/notifications/plan-referrer-notify.ts — a
 * write-time hook was proposed first and rejected by council review (2026-08-14) because two dashboard "Mark Invoice
 * Paid" actions settle a tranche invoice without ever calling the shared payment writer, so a hook there would
 * silently miss exactly the manual-confirmation path this feature exists to cover. Reading plan STATE instead of
 * watching write PATHS is immune to that class of gap by construction.
 *
 * Reliability, deliberately: each candidate offer is processed inside its own try/catch so one bad row cannot
 * silently take down the rest of the sweep; a failed note is logged as an error (not swallowed); the whole run is
 * reported to cron_log on both success and failure, so a broken sweep is visible rather than silently going quiet.
 *
 * LEAD-ORIGINATED DEALS (bug-hunter, 2026-08-14): an offer created directly from a lead can carry neither account_id
 * nor contact_id by the time its plan settles. The per-deal code falls back to `findContactIdByEmail` — the
 * codebase's own canonical, dedup/tombstone-aware lookup — rather than a hand-rolled email match.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { isPlanReferrerAutoReleaseEnabled } from "@/lib/notifications/plan-referrer-notify"
import { processPlanReferrerOffer, type SweepOffer } from "@/lib/notifications/plan-referrer-sweep"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const autoReleaseEnabled = isPlanReferrerAutoReleaseEnabled(process.env.PLAN_REFERRER_AUTO_RELEASE)

    // Candidates: a signed/completed offer, carrying a plan, not yet released, with SOMETHING that could be payable
    // (a referrer name, or a linked partner) — the exact hasWorkingPartnerPayout/shouldReleasePlanReferrerCredit
    // checks run per-row; this is just a cheap pre-filter.
    // eslint-disable-next-line no-restricted-syntax -- payment_plan/commission_released_at postdate the generated types for this table.
    const offerQuery = supabaseAdmin
      .from("offers")
      .select("token, client_name, client_email, account_id, contact_id, referrer_name, referrer_contact_id, referrer_account_id, partner_id, partner_payout_model, payment_plan, commission_released_at" as never)
      .in("status", ["signed", "completed"])
      .not("payment_plan" as never, "is", null)
      .is("commission_released_at" as never, null)
      .or("referrer_name.not.is.null,partner_id.not.is.null") as unknown as {
        then: PromiseLike<{ data: SweepOffer[] | null; error: { message: string } | null }>["then"]
      }
    const { data: offers, error: offersErr } = await offerQuery
    if (offersErr) throw new Error(offersErr.message)

    const results: Array<{ token: string; outcome: string }> = []

    for (const offer of offers ?? []) {
      try {
        results.push({ token: offer.token, outcome: await processPlanReferrerOffer(offer, { autoReleaseEnabled }) })
      } catch (rowErr) {
        // Fault isolation: one bad offer must not abort the sweep for the rest.
        results.push({ token: offer.token, outcome: `error: ${rowErr instanceof Error ? rowErr.message : String(rowErr)}` })
      }
    }

    const released = results.filter((r) => r.outcome.startsWith("auto-released"))
    const notified = results.filter((r) => r.outcome.startsWith("notified"))
    const errored = results.filter((r) => r.outcome.startsWith("error") || r.outcome.includes("note failed"))

    logCron({
      endpoint: "/api/cron/plan-referrer-notify",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: results.length, auto_released: released.length, notified: notified.length, errored: errored.length, auto_release_enabled: autoReleaseEnabled, results },
    })

    return NextResponse.json({
      ok: true,
      checked: results.length,
      auto_released: released.length,
      notified: notified.length,
      errored: errored.length,
      results,
    })
  } catch (err) {
    logCron({
      endpoint: "/api/cron/plan-referrer-notify",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
