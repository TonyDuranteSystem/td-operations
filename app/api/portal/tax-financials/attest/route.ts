/**
 * POST /api/portal/tax-financials/attest — { account_id, tax_year }
 *
 * The financials attestation (Slice 8, master plan §3.7 + W5): the client
 * declares the generated P&L / Balance Sheet numbers are true. Stored ON THE
 * SUBMISSION ROW (confirmation_accepted + client_ip + client_user_agent +
 * a review_history entry) — it does NOT touch review_status; the existing
 * staff-review → approve → final-confirm machine is unchanged.
 *
 * Refused while any BLOCKING gate fails. Since 2026-08-03 no gate is blocking
 * (Antonio: the client may confirm with items still undecided — "we just
 * suggest but they know the truth"), so this check is a kept-in-place guard for
 * any future blocking gate rather than a live barrier. What still refuses:
 * unanswered/incomplete coverage questions. What the client accepted is
 * RECORDED — the number of transactions still booked on our suggestion at the
 * moment of attestation goes into the review_history entry, so we can always
 * show exactly how much of a confirmed P&L was ours, not theirs. (Deliberately
 * NOT mirrored into financials_meta: that column is read-modify-written by the
 * coverage route too, and a second whole-object write here could clobber a
 * concurrent coverage answer.)
 * OWNER-ONLY — attestation is signing-like, never a teammate's.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // Staff pass isAccountOwner, but the attestation is the CLIENT's act alone.
    if ((user.app_metadata as Record<string, unknown> | undefined)?.role !== 'client') {
      return NextResponse.json({ error: 'Only the client can attest their financials.' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    if (!accountId || !Number.isInteger(taxYear)) {
      return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // LOCK (added 2026-08-03, bug-hunter blocker). This route had NO
    // client-editable check — it only guarded role, ownership and in-flight
    // ingestion. So a client whose file is `under_review` could be shown the
    // "your file is with our team" banner, scroll past it, tick the box and
    // press Confirm: `confirmation_accepted` flipped and `runAttestHandoff`
    // fired, archiving a "(client-confirmed)" workbook to Drive and raising a
    // staff task WHILE STAFF WERE STILL REVIEWING. `approved` is client-editable
    // so the legitimate approve → confirm path is untouched; `confirmed` is not,
    // which also makes a second attestation a clean refusal.
    // Same lookup shape as the other write routes and as the GET's banner
    // (latest submission for the account+year, NO status filter) so the banner
    // and this refusal can never disagree.
    const { resolveEditability } = await import('@/lib/tax/resolve-submission')
    const { editable: canEdit } = await resolveEditability(supabaseAdmin, accountId, taxYear)
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it before confirming.' },
        { status: 409 },
      )
    }

    // Server-side guard: never attest while statements are still being read.
    // The numbers are still changing, and a premature confirmation fires the
    // handoff (Excel archive + staff task) on incomplete data. The UI disables
    // the button while ingestPending > 0; this enforces it server-side too.
    const { countInFlightIngestJobs } = await import('@/lib/tax/ingest-status')
    if ((await countInFlightIngestJobs(accountId, taxYear)) > 0) {
      return NextResponse.json(
        { error: 'Your statements are still being processed. Please wait until they have all been read, then confirm.' },
        { status: 409 },
      )
    }

    // Same guard, next pipeline stage (W10, 2026-08-18): never attest while
    // smart categorization is actively running. Ingestion finishing is not
    // enough — a chunk can still be mid-run reclassifying transactions after
    // every file has landed, and confirming then attests to numbers about to
    // change under the client (WSCP case). The UI disables Confirm via
    // confirmBlockers while aiPending > 0; this enforces it server-side too.
    const { chainStateForScope } = await import('@/lib/jobs/chain-watchdog')
    const aiChain = await chainStateForScope({ jobType: 'recategorize_ai', accountId, taxYear })
    if (aiChain.state === 'running') {
      return NextResponse.json(
        { error: 'We are still finishing the automatic classification of your transactions. Please wait a moment and try again.' },
        { status: 409 },
      )
    }

    // Every blocking gate must pass right now. No gate is blocking today (see
    // the header) — kept so a future blocking gate is enforced automatically.
    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)
    if (!view.canConfirm) {
      const blocked = view.gates.filter(g => g.blocking && g.status === 'fail').map(g => g.detail).join(' ')
      return NextResponse.json({ error: blocked || 'Not everything is verified yet.' }, { status: 422 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // financials_meta not yet in database.types.ts
    // SAME resolver as the lock above (2026-08-03) — two different reads meant
    // the lock could be judged on one row and the attestation written to
    // another. It also used to demand `status='completed'`, so a client whose
    // row had become `reviewed` could never confirm at all: a permanent 404 on
    // the last step of their tax return.
    const { resolveClientSubmission } = await import('@/lib/tax/resolve-submission')
    const sub = await resolveClientSubmission<{ id: string; review_history: unknown; confirmation_accepted: boolean | null; financials_meta: Record<string, unknown> | null }>(
      db, accountId, taxYear, 'id, review_history, confirmation_accepted, financials_meta',
    )
    if (!sub) return NextResponse.json({ error: 'No submission found for this year.' }, { status: 404 })

    // HARD BLOCK on failed/quarantined statement files (card 4a39e0fd,
    // Antonio's binding ruling 2026-08-12): a failed file means an entire bank
    // account may be missing from the numbers — confirming over that hole
    // fires the handoff on incomplete data. Staff can override from the CRM
    // (reason required, logged, client notified) — the override lives in
    // financials_meta.failed_files_override, written ONLY by the staff unlock
    // route. Quarantined files block too: they are ours to confirm, and the
    // requeue-on-confirm flow clears them without the client doing anything.
    {
      const { data: ingestJobs } = await supabaseAdmin
        .from('job_queue')
        .select('status, result, payload')
        .eq('job_type', 'ingest_bank_statement')
        .eq('account_id', accountId)
        .neq('status', 'cancelled')
      const { computeIngestFileStates, summarizeIngestFileStates } = await import('@/lib/tax/ingest-file-status')
      const counts = summarizeIngestFileStates(computeIngestFileStates(
        (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean; steps?: Array<{ detail?: string }> } | null; payload: { tax_year?: number | string; path?: string } | null }>,
        taxYear,
      ))
      const override = (sub.financials_meta ?? {}) as Record<string, unknown>
      const overridden = typeof override.failed_files_override === 'object' && override.failed_files_override !== null
      // The staff override covers FAILED files only (that is the judgment the
      // unlock records). QUARANTINED files always block: they are OURS to
      // confirm, and the confirm auto-requeue drains them — an override must
      // not paper over our own queue (round 3: with quarantined covered, the
      // UI stayed locked while the server would have allowed — and the unlock
      // message lied to the client).
      const blockedFiles = (overridden ? 0 : counts.failed) + counts.quarantined
      if (blockedFiles > 0) {
        return NextResponse.json(
          {
            error:
              counts.quarantined > 0
                ? 'One of your bank statements is being format-checked by our team. Nothing is needed from you — you will be able to confirm as soon as it is processed.'
                : blockedFiles === 1
                  ? 'One of your bank statements could not be processed, so the numbers are not complete yet. Our team has been notified and is on it — you will be able to confirm as soon as it is resolved.'
                  : `${blockedFiles} of your bank statements could not be processed, so the numbers are not complete yet. Our team has been notified and is on it — you will be able to confirm as soon as they are resolved.`,
          },
          { status: 409 },
        )
      }
    }

    // Coverage must be resolved too (§3.4) — gate 1 can't see what an export
    // left out; the client's answers are the completeness guarantee.
    const { coverageQuestions, unansweredCoverage, incompleteCoverage } = await import('@/lib/tax/coverage')
    // Paginated — finalize-time coverage must see ALL rows, not the first 1000,
    // or a >1000-tx client could attest on a truncated month-span (the gate
    // that sends data toward filing).
    const covRows = await fetchAllPaged(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from('bank_transactions')
        .select('bank_name, account_type, transaction_date')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return data ?? []
    })
    const covQs = coverageQuestions(covRows, taxYear)
    const covAnswers = (sub.financials_meta?.coverage_answers ?? {}) as import('@/lib/tax/coverage').CoverageAnswers
    const unanswered = unansweredCoverage(covQs, covAnswers)
    const incomplete = incompleteCoverage(covQs, covAnswers)
    if (unanswered.length > 0) {
      return NextResponse.json({ error: `Please answer the remaining coverage question(s) first: ${unanswered.map(q => q.question).join(' ')}` }, { status: 422 })
    }
    if (incomplete.length > 0) {
      return NextResponse.json({ error: `You told us these exports are incomplete — please delete the file and upload the entire period: ${incomplete.map(q => q.bank_key).join(', ')}.` }, { status: 422 })
    }

    // What was still OUR suggestion at the moment they confirmed (2026-08-03).
    // The client may confirm with items undecided, so the record must say how
    // many — otherwise a confirmed P&L looks fully client-approved forever and
    // nobody can tell later which figures they actually chose. Exactly one of
    // the two counters is non-zero by construction (see gate 6).
    const suggestedNotReviewed =
      view.draft.pnl.uncategorizedCount + view.draft.pnl.foldedUncategorizedCount
    const suggestedNet =
      view.draft.pnl.uncategorizedTotal
      + view.draft.pnl.foldedUncategorizedIncome
      - view.draft.pnl.foldedUncategorizedExpense

    const history = Array.isArray(sub.review_history) ? sub.review_history : []
    const entry = {
      at: new Date().toISOString(),
      actor: 'client',
      event: 'financials_attested',
      note: `Client attested the generated P&L and Balance Sheet for ${taxYear} (gates: ${view.gates.map(g => `${g.id}=${g.status}`).join(', ')}; ${suggestedNotReviewed} transaction(s) net ${suggestedNet.toFixed(2)} were still booked on our suggestion, not reviewed by the client).`,
      suggested_not_reviewed: suggestedNotReviewed,
      suggested_not_reviewed_net: Number(suggestedNet.toFixed(2)),
    }
    // Captured BEFORE the write below, same value the response already
    // returns as `already` — the one signal that tells whether this call is a
    // genuine new confirmation or a re-entrant duplicate (double-click, stale
    // second tab). Dev job 9b7892d6: the two new staff-notification calls
    // below MUST be gated on this, not fired unconditionally, or a duplicate
    // call would post a spurious "client confirmed" signal for nothing that
    // actually changed.
    const wasAlreadyConfirmed = sub.confirmation_accepted === true

    const { error } = await supabaseAdmin
      .from('tax_return_submissions')
      .update({
        confirmation_accepted: true,
        client_ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        client_user_agent: request.headers.get('user-agent') ?? null,
        review_history: [...history, entry],
      })
      .eq('id', sub.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Staff notifications (dev job 9b7892d6): a proper Notification Center
    // card + What's New note, placed HERE — in the request's own awaited path,
    // right after the confirmation write above succeeds — not inside the
    // fire-and-forget handoff below, so they fire reliably regardless of
    // whether that handoff ever runs. Skipped entirely on a re-entrant
    // duplicate call (wasAlreadyConfirmed): nothing actually changed, so
    // nothing should be announced. On a genuine RE-attestation (this row's
    // confirmation_accepted was reset to false by a correction — see
    // lib/tax/attestation.ts — and is being confirmed again), retire the
    // stale note first so the marker dedup doesn't swallow the new one; the
    // Notification Center card needs no retire step (its own dedup only
    // blocks while an OPEN card already exists, and self-heals once staff
    // resolve it).
    if (!wasAlreadyConfirmed) {
      try {
        const { emitFinancialsAttestedEvent, retireFinancialsAttestedNote } = await import('@/lib/portal/chat-events')
        const isReattestation = Array.isArray(history) && history.some(
          (h) => h && typeof h === 'object' && (h as { event?: string }).event === 'financials_attested',
        )
        if (isReattestation) {
          await retireFinancialsAttestedNote({ taxReturnSubmissionId: sub.id })
        }
        await emitFinancialsAttestedEvent({
          tax_return_submission_id: sub.id,
          account_id: accountId,
          tax_year: taxYear,
          is_reattestation: isReattestation,
        })
        const { emitActionNeeded } = await import('@/lib/notifications/act-event')
        await emitActionNeeded({
          event: 'financials_confirmed',
          account_id: accountId,
          source_ref: `tax_return_submissions:${sub.id}`,
        })
      } catch (e) {
        console.error('[tax-financials] staff notification error:', e)
      }
    }

    // Handoff (Slice 9 §3.7, fire-and-forget — the response never waits):
    // archive the confirmed Excel to Drive 3.Tax/{year}. Failures are logged;
    // staff already have the notification above regardless of this outcome.
    void import('@/lib/tax/attest-handoff')
      .then(({ runAttestHandoff }) => runAttestHandoff(accountId, taxYear))
      .catch(e => console.error('[tax-financials] attest handoff failed:', e))

    return NextResponse.json({ attested: true, already: wasAlreadyConfirmed })
  } catch (err) {
    console.error('[tax-financials] attest failed:', err)
    return NextResponse.json({ error: 'Could not record your confirmation — please try again.' }, { status: 500 })
  }
}
