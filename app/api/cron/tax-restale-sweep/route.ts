/**
 * Stale-classification sweep — re-sort a client's transactions after their
 * record improves.
 *
 * A client's bank transactions are categorised ONCE, at ingest. The sort reads
 * the client record — member names, the company's legal name, declared related
 * companies — so when that record is corrected or completed LATER, everything
 * already sorted keeps the old, wrong answer and nothing notices.
 *
 * That is how five payments to Lucia Terracciano and Antonio Pezzella sat as
 * "internal transfers" instead of owner draws (2026-08-03): both were linked
 * as contacts on their accounts after their statements were ingested, so the
 * member rule never got to run. Hidden as transfers, the money reached neither
 * the P&L nor the members' capital accounts. The engine could always have
 * corrected it — pass 1 re-applies the rules to every row and rewrites any
 * category that no longer matches. Nothing ever asked it to.
 *
 * Safety posture (mirrors the other tax sweeps):
 * - REPORT-ONLY by default. Writes nothing until TAX_RESTALE_SWEEP_DRY_RUN is
 *   explicitly "false". A job that rewrites client money is watched first.
 * - CONFIRMED RETURNS ARE NEVER TOUCHED. Once the client has attested, the
 *   numbers are theirs; a correction there is staff reopening it, not a cron.
 * - HUMAN ANSWERS ARE NEVER TOUCHED — rows the client or staff answered carry
 *   a "manual:" note and the engine already refuses them, at any frequency.
 * - Deterministic passes only, never the AI pass (costs money, not repeatable).
 * - Capped per run; leftovers are picked up on the next tick.
 * - Every account-year that would change is logged and, when something really
 *   changes, posted to the team channel — a silent re-sort of client money is
 *   exactly what we are fixing, so this one announces itself.
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { reportSystemError } from "@/lib/system-errors"
import { postTeamMessage } from "@/lib/team/post-message"
import {
  decideRestale,
  describeRestaleResult,
  restaleIsDryRun,
  RESTALE_MAX_ACCOUNTS_PER_RUN,
  type RestaleCandidate,
} from "@/lib/tax/restale-sweep"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const ENDPOINT = "/api/cron/tax-restale-sweep"

export async function GET(request: NextRequest) {
  const started = Date.now()
  const dryRun = restaleIsDryRun(process.env)
  try {
    const auth = request.headers.get("authorization")
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Candidates: every account-year that HAS transactions, with whether the
    // client has already confirmed. One grouped read; the decision itself is
    // pure and unit-tested (decideRestale).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data: txAgg } = await db
      .from("bank_transactions")
      .select("account_id, tax_year")
      .limit(50000)
    const counts = new Map<string, { account_id: string; tax_year: number; n: number }>()
    for (const r of (txAgg ?? []) as Array<{ account_id: string; tax_year: number }>) {
      if (!r.account_id || !r.tax_year) continue
      const k = `${r.account_id}:${r.tax_year}`
      const e = counts.get(k) ?? { account_id: r.account_id, tax_year: r.tax_year, n: 0 }
      e.n++
      counts.set(k, e)
    }

    const { data: subs } = await db
      .from("tax_return_submissions")
      .select("account_id, tax_year, confirmation_accepted")
    const confirmed = new Set(
      ((subs ?? []) as Array<{ account_id: string; tax_year: number; confirmation_accepted: boolean | null }>)
        .filter(s => s.confirmation_accepted === true)
        .map(s => `${s.account_id}:${s.tax_year}`),
    )

    const candidates: RestaleCandidate[] = Array.from(counts.values()).map(c => ({
      account_id: c.account_id,
      tax_year: c.tax_year,
      transactions: c.n,
      confirmed: confirmed.has(`${c.account_id}:${c.tax_year}`),
    }))

    const eligible = candidates
      .filter(c => decideRestale(c).eligible)
      .sort((a, b) => a.transactions - b.transactions) // cheapest first
      .slice(0, RESTALE_MAX_ACCOUNTS_PER_RUN)

    const { recategorizeAccountYear } = await import("@/lib/tax/categorization-engine")
    const changedLines: string[] = []
    let totalChanged = 0

    for (const c of eligible) {
      const { data: acct } = await db.from("accounts").select("company_name").eq("id", c.account_id).maybeSingle()
      const company = (acct?.company_name as string) ?? c.account_id
      try {
        const res = await recategorizeAccountYear(c.account_id, c.tax_year, { dryRun })
        if (res.recategorized > 0) {
          totalChanged += res.recategorized
          changedLines.push(describeRestaleResult({
            company, taxYear: c.tax_year, scanned: res.scanned, changed: res.recategorized, dryRun,
          }))
        }
      } catch (e) {
        await reportSystemError({
          source: "server",
          route: ENDPOINT,
          message: `Re-sort failed for ${company} ${c.tax_year}: ${e instanceof Error ? e.message : String(e)}`,
          context: { account_id: c.account_id, tax_year: c.tax_year, dryRun },
        }).catch(() => {})
      }
    }

    // Announce, never re-sort in silence. The whole point of this job is that
    // money moving between categories should be visible to a human.
    if (changedLines.length > 0) {
      const head = dryRun
        ? "🔎 Stale-classification sweep (REPORT ONLY — nothing was written):"
        : "♻️ Stale-classification sweep — transactions re-sorted after client details changed:"
      try {
        await postTeamMessage({
          channel: "td-taxreturn",
          message: `${head}\n${changedLines.map(l => `• ${l}`).join("\n")}`,
        })
      } catch (e) {
        console.error("[tax-restale-sweep] team post failed (sweep result stands):", e)
      }
    }

    const result = {
      ok: true,
      dryRun,
      candidates: candidates.length,
      eligible: eligible.length,
      accountsWithChanges: changedLines.length,
      transactionsChanged: totalChanged,
      details: changedLines,
      ms: Date.now() - started,
    }
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - started, details: result })
    return NextResponse.json(result)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - started, details: { detail } })
    await reportSystemError({ source: "server", route: ENDPOINT, message: `Sweep failed: ${detail}` }).catch(() => {})
    return NextResponse.json({ ok: false, error: detail }, { status: 500 })
  }
}
