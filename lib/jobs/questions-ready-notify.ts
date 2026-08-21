/**
 * AI categorization chain finished → "some items need your decision" notice.
 *
 * Why this exists (Phase B, 2026-07-08):
 * The wizard's ingest-complete notice (lib/jobs/ingest-complete-notify.ts)
 * invites the client to review as soon as their statements are READ — but the
 * AI categorization chain (recategorize_ai) keeps running afterwards, and only
 * when it completes is the "Needs your decision" queue final. A client who
 * never returns after the first notice, or whose AI pass finished long after
 * they looked, never learns that open questions are blocking their confirm.
 * This posts the action-required package once the chain lands cleanly with
 * questions still open.
 *
 * Gates (all must pass — the helper self-gates and never throws):
 * - `remaining > 0` — nothing to decide → no message (the ingest-complete
 *   notice already invited a plain review).
 * - An OPEN tax_returns row (data_received=false) exists for account+year —
 *   the portal financials page only serves open years (year-picker contract),
 *   so without one the deep link would bounce the client to /portal.
 * - The action-required engine's own 10-minute dedup on the link suppresses
 *   double-fires from racing chain tails. The link is year-scoped and distinct
 *   from the save/ingest notices (its own `#needs-your-decision` anchor) so
 *   those never mask this.
 *
 * A LATER clean chain completion (e.g. staff re-runs the AI pass and new
 * questions appear) notifies again by design — new questions are new work.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface QuestionsReadyNotifyResult {
  notified: boolean
  reason?: string
}

export async function notifyQuestionsReady(params: {
  accountId: string
  taxYear: number
  remaining: number
  /** DI seam for tests. */
  notifyFn?: (p: {
    account_id: string
    title: { en: string; it: string }
    message: { en: string; it: string }
    link: string
  }) => Promise<unknown>
}): Promise<QuestionsReadyNotifyResult> {
  const { accountId, taxYear, remaining } = params
  try {
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return { notified: false, reason: "nothing_open" }
    }

    const { count: openYear } = await supabaseAdmin
      .from("tax_returns")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .eq("data_received", false)
    if (!openYear || openYear === 0) {
      return { notified: false, reason: "no_open_return" }
    }

    const notify = params.notifyFn
      ?? (await import("@/lib/portal/action-required")).notifyClientActionRequired
    await notify({
      account_id: accountId,
      title: {
        en: `A few items need your decision — ${taxYear} financials`,
        it: `Alcune voci richiedono una tua decisione — bilancio ${taxYear}`,
      },
      message: {
        en: `We've finished categorizing your ${taxYear} transactions automatically. ${remaining} item(s) can only be classified by you — each takes one tap in the portal. Once they're answered you can confirm your Profit & Loss.`,
        it: `Abbiamo finito di registrare automaticamente le tue transazioni ${taxYear}. ${remaining} voce/i possono essere classificate solo da te — un tocco ciascuna nel portale. Una volta risposte potrai confermare il tuo Conto Economico.`,
      },
      // #needs-your-decision (2026-08-20): a real anchor the page scrolls to
      // on load, replacing the old ?focus=questions — nothing ever read that
      // query param, so the "click brings you straight to it" promise in the
      // message text above was never actually true. See the component's own
      // hash-scroll effect.
      link: `/portal/tax-financials?year=${taxYear}#needs-your-decision`,
    })
    return { notified: true }
  } catch (e) {
    console.error(`[questions-ready-notify] failed for account ${accountId} ${taxYear}:`, e)
    return { notified: false, reason: "exception" }
  }
}
