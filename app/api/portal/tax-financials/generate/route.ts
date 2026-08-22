/**
 * POST /api/portal/tax-financials/generate — re-run the categorization
 * passes on a real account's own bank data (STAFF ONLY — Recall a client).
 *
 * The account-mode twin of app/api/tools/pnl/[id]/generate/route.ts. A real
 * account has no "generated_at" gate — its financials are always computed
 * live from bank_transactions — so this route skips that stamp entirely and
 * does only the two things "Re-run P&L" is actually for: refuse while a
 * statement is still being ingested, then re-run the deterministic pass +
 * queue the AI-assist pass on whatever it leaves uncategorized. Same
 * machinery the client's own upload already runs (lib/tax/portal-csv-ingest.ts),
 * just re-triggerable by staff without a new file.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const accountId = String(body.account_id ?? '')
  const taxYear = Number(body.tax_year)
  if (!accountId || !Number.isInteger(taxYear)) {
    return NextResponse.json({ error: 'We need the client and tax year to re-run this — please reload the page and try again.' }, { status: 400 })
  }

  try {
    // Same per-file pending logic as the GET view (lib/tax/ingest-file-status.ts)
    // — a statement still being read must block re-run the same way it blocks
    // a workspace's first Generate, or the pass runs on a partial file set.
    const { data: ingestJobs } = await supabaseAdmin
      .from('job_queue')
      .select('status, result, payload')
      .eq('job_type', 'ingest_bank_statement')
      .eq('account_id', accountId)
      .in('status', ['pending', 'processing', 'failed', 'completed'])
    const { computeIngestFileStates, summarizeIngestFileStates } = await import('@/lib/tax/ingest-file-status')
    const ingestJobRows = (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean } | null; payload: { tax_year?: number | string; path?: string } | null }>
    const fileStates = computeIngestFileStates(ingestJobRows, taxYear)
    const { pending } = summarizeIngestFileStates(fileStates)
    if (pending > 0) {
      return NextResponse.json(
        { error: `${pending} statement(s) are still processing — wait for them to finish, then re-run.`, pending },
        { status: 409 },
      )
    }

    // Hard-stop parity (2026-08-21, round-3 follow-up): re-running categorization
    // on data with an unreadable statement or an unresolved missing-months
    // question wastes real compute (the deterministic pass + a queued AI-assist
    // job) on numbers the display/download routes already correctly withhold
    // regardless of whether this succeeds. Safe to check unconditionally here —
    // unlike the workspace twin below, a real account has no upload/review mode
    // toggle for this route to gate; the review screen is always reachable.
    const { getAccountStructuralProblem, getAccountOwnershipProblem } = await import('@/lib/tax/financials-orchestration')
    if (await getAccountStructuralProblem(accountId, taxYear)) {
      return NextResponse.json(
        { error: 'This year has an unresolved data problem (an unreadable statement, or a missing-months question) — fix that first, then re-run.' },
        { status: 409 },
      )
    }

    // 2026-08-22 (Antonio): check ownership before running anything, not just
    // before download — re-running categorization on a broken split is the
    // same "don't compute on known-wrong input" principle, and this is the
    // literal "before the tool runs any profit and loss" entry point for a
    // real account. Only fires on an ENTERED-but-wrong split (see
    // ownershipIsBroken) — an account that simply hasn't finished entering
    // ownership yet is untouched, same as every other in-progress state here.
    const ownershipProblem = await getAccountOwnershipProblem(accountId, taxYear)
    if (ownershipProblem) {
      return NextResponse.json({ error: ownershipProblem }, { status: 409 })
    }

    const { recategorizeAccountYear } = await import('@/lib/tax/categorization-engine')
    const recat = await recategorizeAccountYear(accountId, taxYear)
    if (recat.handsOffSkipped) {
      return NextResponse.json(
        { error: 'The client has already confirmed this return — reopen it first if the numbers really need to change.' },
        { status: 409 },
      )
    }

    // Same idempotent AI-enqueue as the client's own upload path
    // (lib/tax/portal-csv-ingest.ts) — at most one pending recategorize_ai job
    // per account+year, direct insert (never enqueueJobs()'s dangling
    // triggerWorker fetch, which outlives the response — the documented
    // Vercel teardown bug). The 5-min process-jobs cron drains it.
    let aiQueued = false
    if (recat.uncategorizedRemaining > 0) {
      const { data: existing } = await supabaseAdmin
        .from('job_queue')
        .select('id')
        .eq('job_type', 'recategorize_ai')
        .eq('account_id', accountId)
        .eq('payload->>tax_year', String(taxYear))
        .in('status', ['pending', 'processing'])
        .limit(1)
      if (!existing || existing.length === 0) {
        await supabaseAdmin.from('job_queue').insert({
          job_type: 'recategorize_ai',
          payload: { account_id: accountId, tax_year: taxYear },
          account_id: accountId,
          created_by: 'tax_financials_generate',
        } as never)
      }
      aiQueued = true
    }

    return NextResponse.json({ ok: true, aiQueued })
  } catch (err) {
    console.error('[tax-financials/generate] failed:', err)
    return NextResponse.json({ error: 'Could not re-run — please try again.' }, { status: 500 })
  }
}
