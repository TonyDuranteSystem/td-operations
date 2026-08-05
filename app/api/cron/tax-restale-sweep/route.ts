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
  sweepBudgetExhausted,
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
    // MUST be paged. supabase-js caps a single select at 1000 rows, so a plain
    // `.limit(50000)` here silently returned a twentieth of the table (19,463
    // rows today) — the sweep would have built its candidate list from a
    // fraction of the data, miscounting transactions per account-year and
    // skipping most clients entirely. Same trap this table already has a
    // dedicated helper for; see lib/bank-transactions-fetch.ts. Caught in QA
    // before this ever ran.
    const { fetchAllPaged } = await import("@/lib/bank-transactions-fetch")
    const txAgg = await fetchAllPaged<{ account_id: string; tax_year: number }>(async (from, to) => {
      const { data, error } = await db
        .from("bank_transactions")
        .select("account_id, tax_year")
        .order("id", { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Array<{ account_id: string; tax_year: number }>
    })
    const counts = new Map<string, { account_id: string; tax_year: number; n: number }>()
    for (const r of txAgg) {
      if (!r.account_id || !r.tax_year) continue
      const k = `${r.account_id}:${r.tax_year}`
      const e = counts.get(k) ?? { account_id: r.account_id, tax_year: r.tax_year, n: 0 }
      e.n++
      counts.set(k, e)
    }

    // FAIL CLOSED. This is the query that protects attested and under-review
    // returns, and it used to discard its error — one timeout and `subs` came
    // back null, every client looked unconfirmed, and the sweep would have
    // re-sorted returns clients had already signed off on while logging
    // success. Paged for the same reason as the transactions read: a single
    // select caps at 1000 rows (94 today, but the guard must not rot).
    const subs = await fetchAllPaged<{
      account_id: string; tax_year: number
      confirmation_accepted: boolean | null; review_status: string | null
    }>(async (from, to) => {
      const { data, error } = await db
        .from("tax_return_submissions")
        .select("account_id, tax_year, confirmation_accepted, review_status")
        .order("id", { ascending: true })
        .range(from, to)
      // Throwing here aborts the whole run. That is the point: no protection
      // data means no sweep, never a sweep with the guard switched off.
      if (error) throw new Error(`submission guard read failed: ${error.message}`)
      return (data ?? []) as Array<{
        account_id: string; tax_year: number
        confirmation_accepted: boolean | null; review_status: string | null
      }>
    })
    // BOTH signals, gathered per account-year. An account-year can carry more
    // than one submission row (13 do, book-wide), so every row's state counts —
    // the strictest wins inside decideRestale.
    const confirmed = new Set<string>()
    const statuses = new Map<string, (string | null)[]>()
    for (const s of subs) {
      const k = `${s.account_id}:${s.tax_year}`
      if (s.confirmation_accepted === true) confirmed.add(k)
      statuses.set(k, [...(statuses.get(k) ?? []), s.review_status])
    }

    const candidates: RestaleCandidate[] = Array.from(counts.values()).map(c => ({
      account_id: c.account_id,
      tax_year: c.tax_year,
      transactions: c.n,
      confirmed: confirmed.has(`${c.account_id}:${c.tax_year}`),
      reviewStatuses: statuses.get(`${c.account_id}:${c.tax_year}`) ?? [],
    }))

    // Deterministic order + NO SILENT TRUNCATION. The first cut took the 8
    // SMALLEST every run with no memory of what it had already swept, so the
    // same handful of tiny account-years were processed forever and the real
    // ones (LT Program, TP Balance — the accounts this exists for) were never
    // reached, while the job reported itself healthy. The cap now comfortably
    // covers the whole book (16 account-years today); if it is ever exceeded,
    // the overflow is REPORTED, not dropped in silence.
    const allEligible = candidates
      .filter(c => decideRestale(c).eligible)
      .sort((a, b) => (a.account_id === b.account_id ? a.tax_year - b.tax_year : a.account_id.localeCompare(b.account_id)))
    const eligible = allEligible.slice(0, RESTALE_MAX_ACCOUNTS_PER_RUN)
    const skippedForCap = allEligible.length - eligible.length

    const { recategorizeAccountYear } = await import("@/lib/tax/categorization-engine")
    const changedLines: string[] = []
    let totalChanged = 0
    let totalMarks = 0
    let stoppedForTime = 0

    for (const c of eligible) {
      // Stop BEFORE the platform kills us mid-write. A killed run leaves rows
      // rewritten with no announcement at all — the one thing this job promises
      // never to do — and restarts from the same alphabetical head every time,
      // starving the tail.
      if (sweepBudgetExhausted(started, Date.now())) {
        stoppedForTime = eligible.length - eligible.indexOf(c)
        break
      }
      const { data: acct } = await db.from("accounts").select("company_name").eq("id", c.account_id).maybeSingle()
      const company = (acct?.company_name as string) ?? c.account_id
      try {
        const res = await recategorizeAccountYear(c.account_id, c.tax_year, { dryRun })
        // categoryChanged, NOT recategorized — the latter counts note-only
        // rewrites (849 rows book-wide re-stamp their note every run), which
        // would drown a real correction in permanent noise.
        // Announce a MARK-ONLY run too. The suspected-owner mark never moves a
        // category, so gating the post on categoryChanged meant the very case
        // this sweep exists for — a member linked in the CRM after ingest —
        // raised new owner questions on a client's portal and told nobody.
        if (res.categoryChanged > 0 || res.marksChanged > 0) {
          totalChanged += res.categoryChanged
          totalMarks += res.marksChanged
          changedLines.push(describeRestaleResult({
            company, taxYear: c.tax_year, scanned: res.scanned,
            changed: res.categoryChanged, marks: res.marksChanged, dryRun,
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
    // money moving between categories should be visible to a human — and so
    // must NOT-REACHING accounts. A time-stop or cap overflow with zero changed
    // lines used to post nothing at all: the run would stall on the same
    // alphabetical head every tick (no cursor), the tail would starve for ever,
    // and the only trace was a JSON field nobody reads. That is precisely the
    // starvation this job's own comments promise to report.
    const overflow = (skippedForCap > 0 ? `\n⚠️ ${skippedForCap} more account-year(s) were NOT reached this run — the book has outgrown one pass and needs a swept-at marker.` : "")
      + (stoppedForTime > 0 ? `\n⏱️ Stopped on the time budget with ${stoppedForTime} account-year(s) unreached — they are picked up next run.` : "")
    if (changedLines.length > 0 || overflow) {
      const head = dryRun
        ? "🔎 Stale-classification sweep (REPORT ONLY — nothing was written):"
        : "♻️ Stale-classification sweep — transactions re-sorted after client details changed:"
      const body = changedLines.length > 0 ? `\n${changedLines.map(l => `• ${l}`).join("\n")}` : "\n(no category or owner-question changes this run)"
      try {
        await postTeamMessage({
          channel: "td-taxreturn",
          message: `${head}${body}${overflow}`,
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
      skippedForCap,
      stoppedForTime,
      transactionsChanged: totalChanged,
      ownerQuestionsChanged: totalMarks,
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
