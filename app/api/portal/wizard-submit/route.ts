/**
 * POST /api/portal/wizard-submit — Submit completed wizard data.
 *
 * THIN DISPATCHER (Phase 2 Auto-Chain):
 * 1. Saves wizard_progress + submission record (fast, inline)
 * 2. Enqueues a background job for the full auto-chain (non-blocking)
 * 3. Returns immediately so client gets fast response
 *
 * All wizard types use fire-and-forget execution:
 * - banking_payset / banking_relay: inline IIFE, early return (step 4b)
 * - tax_form_setup: inline IIFE, then return (step 6)
 * - all others (onboarding_setup, formation_setup, itin_review, etc.): cron at
 *   /api/cron/process-jobs picks up the enqueued job
 *
 * The background handlers handle ALL heavy work: Drive, CRM updates, OA, Lease,
 * Banking, notifications. Data is always saved before the response is sent.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'
import { enqueueJob, completeJob, failJob, type Job } from '@/lib/jobs/queue'
import { getSubmissionTable, getJobType, isBankingInlineType } from '@/lib/portal/wizard-map'
import { buildSubmissionRecord, preserveReviewedStatus } from '@/lib/portal/submission-record'
import { buildSubmissionToken } from '@/lib/portal/submission-token'
import { accountIdForWizardSubmission } from '@/lib/portal/wizard-scope'
import { validateWizardData } from '@/lib/jobs/validation'
import { collectUploadPaths, isWizardUploadPath } from '@/lib/portal/wizard-uploads'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { canSubmitWizard } from '@/lib/portal/wizard-submit-access'
import { formationLeadOwned } from '@/lib/portal/formation-lead-access'
import {
  resolveTaxWizardEligibility,
  CLOSED_REASON_COPY,
  type TaxWizardEligibility,
  type TaxWizardClosedReason,
} from '@/lib/tax/wizard-eligibility'
import { buildReviewHistoryEntry, type ReviewStatus } from '@/lib/tax/review-status'
import { verifyClosureServiceDelivery } from '@/lib/portal/closure-subject'
import { reportSystemError } from '@/lib/system-errors'
import { markWizardProgressSubmitted } from '@/lib/portal/wizard-progress-write'

/** Extract file upload paths from wizard data.
 * All wizard uploads follow the pattern: {wizardType}/{identifier}/{fieldName}_{unique}_{filename}
 * stored in the "onboarding-uploads" bucket. Detects any value that looks like a
 * storage path. File fields now store an ARRAY of paths (multi-file); the helper
 * flattens both legacy single-string and new array shapes. dev_task 64bfcdd9. */
function extractUploadPaths(data: Record<string, unknown>): string[] {
  return collectUploadPaths(data)
}


// Wizard-map imports moved to lib/portal/wizard-map.ts (P1.7) so the
// characterization exhaustiveness test can verify every VALID_WIZARD_TYPES
// entry has a submission-table or banking-inline coverage. The P0.5 ITIN
// drop class of bug is enforced by that test.

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { wizard_type, entity_type, data, account_id: rawAccountId, contact_id, lead_id, progress_id, allow_resubmit, service_delivery_id: rawServiceDeliveryId } = body

  if (!wizard_type || !data) {
    return NextResponse.json({ error: 'wizard_type and data are required' }, { status: 400 })
  }

  // Server-side backstop: a formation is for a NEW company and lives on the
  // contact (+lead) until the Articles of Organization materialize the real
  // account. It must NEVER carry an account_id. Without this guard, an existing
  // client who reached the formation wizard via any link that dropped the
  // ?lead= scope submitted their new company onto their EXISTING account —
  // the THW Global hijack (Adam Mihaly, 2026-05-20, dev_task 358e8cbe).
  const account_id = accountIdForWizardSubmission(wizard_type, rawAccountId)

  // ─── 0a. ISOLATION GUARD (default-deny) ───
  // The logged-in user must be allowed to submit for this subject. Without this
  // the route trusted the body's account_id / contact_id, so a member of one
  // company could tamper account_id to another company they aren't linked to and
  // submit wizard data onto it. Mirrors the access checks on the other portal
  // routes (chat / payment-links / customers). dev_task b41cc66f.
  const identity = await resolvePortalIdentity(user)
  if (!canSubmitWizard(identity, account_id, contact_id ?? null, wizard_type)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // ─── 0b. FORMATION LEAD OWNERSHIP (default-deny) ───
  // A formation submit is lead-scoped (account_id null). Re-prove the lead
  // belongs to the logged-in person — same check the wizard page uses to gate
  // ?lead= — so a member can't tamper lead_id and submit a formation tied to
  // someone else's new company. dev_task b41cc66f.
  if (lead_id && wizard_type === 'formation') {
    const ctcId = identity.kind === 'contact' ? identity.contactId : null
    const ownerEmails = new Set<string>()
    if (user.email) ownerEmails.add(user.email.toLowerCase())
    if (ctcId) {
      const { data: c } = await supabaseAdmin.from('contacts').select('email').eq('id', ctcId).maybeSingle()
      if (c?.email) ownerEmails.add(String(c.email).toLowerCase())
    }
    const { data: leadOffer } = await supabaseAdmin
      .from('offers')
      .select('client_email, contract_type, contact_id')
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!formationLeadOwned(leadOffer, ctcId, ownerEmails)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // ─── 0b2. CLOSURE SUBJECT RE-VERIFICATION (dev job fbbf4abe) ───
  // Re-check server-side at the moment of ACTUAL submit — not just once when
  // the page rendered — that the client-supplied record genuinely names a
  // still-active closure this contact is really linked to. Closes the
  // stale-tab window Senior Engineer found: the wizard page resolves this
  // once at render time, but a client can leave the tab open while staff
  // cancel/complete the record, or while a second tab switches company, and
  // still submit minutes later with the old value.
  let closureServiceDeliveryId: string | null = null
  if (wizard_type === 'closure' && rawServiceDeliveryId && identity.kind === 'contact') {
    const verified = await verifyClosureServiceDelivery(String(rawServiceDeliveryId), identity.contactId)
    if (!verified) {
      return NextResponse.json({ error: 'This closure request is no longer available. Refresh the page and try again.' }, { status: 409 })
    }
    closureServiceDeliveryId = String(rawServiceDeliveryId)
  }

  // ─── 0. SYNCHRONOUS VALIDATION ───
  // Structural fix: validate at the route boundary so the client sees field
  // errors inline. Previously validation ran inside the background handler,
  // where failures were invisible to the browser (the API had already
  // returned 200 success). The client retried blindly, flooding the queue
  // with duplicate jobs. See dev_task 3d6800c8 for the Luca Gallacci case
  // that motivated this fix.
  const validation = validateWizardData(wizard_type, data as Record<string, unknown>, entity_type)
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        fields: validation.errors.map(e => ({ field: e.field, message: e.message })),
      },
      { status: 400 },
    )
  }

  try {
    // ─── 0c. TAX WIZARD ELIGIBILITY GATE (PTBT incident, dev job 8cc8e1c8) ───
    // MUST run before ANY state write: a rejection after step 2 would leave
    // wizard_progress 'submitted', so the client's retry hits the step-1 dedup
    // and gets a false "Already submitted" with no submission row — silent
    // data loss. This server-side check is the gate that matters; the home
    // card and wizard page consult the same resolver for UX only.
    let taxEligibility: TaxWizardEligibility | null = null
    if (wizard_type === 'tax' || wizard_type === 'tax_return') {
      taxEligibility = await resolveTaxWizardEligibility({ accountId: account_id, contactId: contact_id })
      if (taxEligibility.mode === 'closed' || taxEligibility.mode === 'company_info') {
        const reason: TaxWizardClosedReason =
          taxEligibility.mode === 'company_info' ? 'pre_wizard_stage' : (taxEligibility.reason ?? 'no_tax_return_open')
        console.warn(`[wizard-submit] Tax wizard submit REJECTED (${reason}) account=${account_id} contact=${contact_id}`)
        return NextResponse.json(
          { error: CLOSED_REASON_COPY[reason].en, error_it: CLOSED_REASON_COPY[reason].it, reason },
          { status: 409 },
        )
      }

      // ─── BANK NUMBER GATE (identity build 2026-08-13, card 4a39e0fd) ───
      // The wizard's uploads bypass any form-aware server, so THIS is the one
      // bypass-proof enforcement point: every declared account_number-mode
      // bank must carry its number (or the explicit no-number escape).
      // Grandfather: a numberless bank identical to one on the client's PRIOR
      // submission passes with a staff flag instead of a wall — the 13
      // already-submitted clients re-editing are never stranded by a rule
      // that postdates their submission. Fail-open on infrastructure errors:
      // a registry/prior-read failure must never block a client's submit.
      if (account_id) {
        try {
          const { checkWizardBankNumbers, bankGateMessage } = await import('@/lib/tax/wizard-bank-gate')
          const { loadInstitutionRegistry } = await import('@/lib/tax/institution-registry')
          const { SUBMISSION_DATA_STATUSES } = await import('@/lib/tax/resolve-submission')
          // The gate's year is the PINNED eligibility year — never derived
          // from a calendar (bug-hunter: the wizard sends no tax_year in data,
          // so the old `Number(data?.tax_year) || currentYear-1` always used
          // the calendar and looked up the WRONG prior for back-filers, and
          // for everyone after the January rollover — stranding exactly the
          // re-editors the grandfather protects). Same rule as the route's
          // own tax-year comment further down.
          const gateYear = taxEligibility?.taxYear ?? null
          // Prior read with the ERROR SURFACED (bug-hunter: the shared
          // resolver swallows supabase errors, so a DB blip read as "no prior"
          // and WALLED a legitimately grandfathered client — inverting the
          // fail-open promise). An error here skips the gate entirely.
          let priorData: Record<string, unknown> | null = null
          if (gateYear !== null) {
            const { data: priorRow, error: priorErr } = await supabaseAdmin
              .from('tax_return_submissions')
              .select('submitted_data')
              .eq('account_id', account_id)
              .eq('tax_year', gateYear)
              .in('status', SUBMISSION_DATA_STATUSES as unknown as string[])
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (priorErr) throw new Error(`prior-submission read failed: ${priorErr.message}`)
            priorData = (priorRow?.submitted_data as Record<string, unknown> | null) ?? null
          }
          const gate = checkWizardBankNumbers({
            data: (data ?? {}) as Record<string, unknown>,
            registry: await loadInstitutionRegistry(),
            priorData,
          })
          if (!gate.ok) {
            const msg = bankGateMessage(gate.missing)
            console.warn(`[wizard-submit] Bank number gate REFUSED account=${account_id}: ${gate.missing.map(m => m.bank).join(', ')}`)
            return NextResponse.json({ error: msg.en, error_it: msg.it, reason: 'bank_number_required' }, { status: 400 })
          }
          if (gate.grandfathered.length > 0) {
            console.warn(`[wizard-submit] Bank number gate GRANDFATHERED account=${account_id}: ${gate.grandfathered.map(m => m.bank).join(', ')}`)
          }
        } catch (e) {
          console.error('[wizard-submit] Bank number gate errored — failing OPEN (submission proceeds):', e)
        }
      }
    }

    // ─── 1. DEDUPLICATION ───
    // Skip dedup check when allow_resubmit=true (client editing a previous submission)
    if (progress_id && !allow_resubmit) {
      const { data: existing } = await supabaseAdmin
        .from('wizard_progress')
        .select('status')
        .eq('id', progress_id)
        .single()
      if (existing?.status === 'submitted') {
        return NextResponse.json({ success: true, message: 'Already submitted' })
      }
    }

    // ─── 2. MARK WIZARD_PROGRESS AS SUBMITTED ───
    // ONLY for banking types here — their own block below returns success
    // immediately afterward and its comment explicitly depends on this
    // already being done ("data is already persisted in wizard_progress
    // (step 2)"). company_info and td_communication already defer their own
    // write until after their real work succeeds (see their own sections).
    //
    // Every OTHER type (formation/onboarding/tax/itin/closure) used to mark
    // this here too — BEFORE the submission-table save (step 4) below,
    // which can itself fail. That let a step-4 failure leave wizard_progress
    // already 'submitted', so the client's automatic retry hit step 1's
    // dedup check and got a false "Already submitted" — silently discarding
    // the submission a second time (dev job 9a9c5cf5, found by Bug Hunter
    // re-attacking this exact PR before merge). Those types now defer the
    // same way company_info always has: marked submitted only after the
    // submission is durably saved AND the background job is enqueued (see
    // "5. DEFERRED WIZARD_PROGRESS WRITE" below) — a retry after ANY
    // failure up to that point finds wizard_progress still NOT 'submitted'
    // and safely re-runs, converging via the submission table's token
    // upsert and the job's content-hash dedup (findRecentDuplicateJob).
    if (isBankingInlineType(wizard_type)) {
      const wpResult = await markWizardProgressSubmitted({
        progressId: progress_id || null,
        wizardType: wizard_type,
        data,
        accountId: account_id || null,
        contactId: contact_id || null,
        leadId: lead_id || null,
        serviceDeliveryId: closureServiceDeliveryId,
      })

      if (wpResult.error) {
        console.error('[wizard-submit] wizard_progress write failed:', wpResult.error.message)
        reportSystemError({
          source: 'server',
          route: '/api/portal/wizard-submit',
          method: 'POST',
          message: `wizard_progress write failed for wizard_type=${wizard_type}: ${wpResult.error.message}`,
          context: { wizard_type, contact_id, account_id, progress_id: progress_id || null },
        }).catch(() => {})
        return NextResponse.json(
          { error: 'Failed to save your progress. Please try submitting again.' },
          { status: 500 },
        )
      }
    }

    // ─── 3. EXTRACT CLIENT + COMPANY NAMES ───
    let clientName = user.user_metadata?.full_name || user.email || 'Client'
    if (data.owner_first_name && data.owner_last_name) {
      clientName = `${data.owner_first_name} ${data.owner_last_name}`
    }

    let companyName = data.company_name || data.llc_name_1 || ''
    if (!companyName && account_id) {
      const { data: acct } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', account_id)
        .single()
      companyName = acct?.company_name || ''
    }

    // ─── 4. SAVE TO SUBMISSION TABLE ───
    const submissionTable = getSubmissionTable(wizard_type)
    let submissionToken: string | null = null
    let submissionId: string | null = null

    if (submissionTable) {
      const uploadPaths = extractUploadPaths(data)

      // Tax year is PINNED by the eligibility resolver — 'open' carries the
      // open tax_returns row's year; 'review' carries the submission's stored
      // year. Never derived from a calendar and never left to the DB column
      // default (the PTBT silent-2025 mechanism).
      const taxYear: number | null = taxEligibility?.taxYear ?? null
      if ((wizard_type === 'tax' || wizard_type === 'tax_return') && taxYear === null) {
        // Defensive: the 0c gate guarantees a year for tax submissions.
        console.error('[wizard-submit] Tax submission reached save with no pinned tax year — gate bug')
        return NextResponse.json(
          { error: CLOSED_REASON_COPY.no_tax_return_open.en, reason: 'no_tax_return_open' },
          { status: 409 },
        )
      }

      if (taxEligibility?.mode === 'review' && taxEligibility.submissionId) {
        // ── REVIEW-LOOP EDIT: update the SAME submission row by id. ──
        // Never the token upsert: the token embeds the CALENDAR year, so a
        // December→January resubmit (and every pre-portal legacy token) would
        // INSERT a twin row and orphan the reviewed one, splitting the review
        // history and the staff task's reference.
        const nowIso = new Date().toISOString()
        const { data: curSub, error: curErr } = await supabaseAdmin
          .from('tax_return_submissions')
          .select('id, token, review_status, review_history, upload_paths')
          .eq('id', taxEligibility.submissionId)
          .single()
        if (curErr || !curSub) {
          console.error('[wizard-submit] Review-mode submission lookup failed:', curErr?.message)
          return NextResponse.json(
            { error: `Failed to save submission: ${curErr?.message ?? 'submission not found'}` },
            { status: 500 },
          )
        }

        // Preserve documents the client already attached (Carasso edit-button
        // fix, 2026-07-23). The form only re-surfaces uploads whose storage path
        // carries a wizard prefix; a document uploaded through the EXTERNAL tax
        // form uses a different path scheme, so a bare overwrite would drop its
        // reference on the first resubmit even though the file still exists in
        // storage. Carry forward ONLY the prior paths the wizard cannot represent
        // (non-wizard-prefixed external docs the client can neither see nor
        // remove). Wizard-prefixed docs come SOLELY from the new form data, so a
        // document the client REPLACED or REMOVED this edit is honored — the old
        // one is not resurrected. `uploadPaths` already holds the wizard-prefixed
        // set the client currently has.
        const priorExternalPaths = Array.isArray(curSub.upload_paths)
          ? (curSub.upload_paths as unknown[]).filter(
              (p): p is string => typeof p === 'string' && !isWizardUploadPath(p),
            )
          : []
        const mergedUploadPaths = Array.from(new Set([...priorExternalPaths, ...uploadPaths]))

        const { error: updErr } = await supabaseAdmin
          .from('tax_return_submissions')
          .update({ submitted_data: data, upload_paths: mergedUploadPaths, updated_at: nowIso })
          .eq('id', curSub.id)
        if (updErr) {
          console.error('[wizard-submit] Review-mode submission update failed:', updErr.message)
          return NextResponse.json(
            { error: `Failed to save submission: ${updErr.message}` },
            { status: 500 },
          )
        }
        submissionId = curSub.id
        submissionToken = curSub.token

        // Close the approve-then-swap window SYNCHRONOUSLY: an edit at
        // 'approved' (or 'reopened') must invalidate the approval BEFORE the
        // client can see a stale "Confirm" banner — the background handler
        // is fire-and-forget and may run seconds later or never. The
        // approved→submitted transition is legal per REVIEW_TRANSITIONS
        // (client edit invalidates approval). revision_requested is left for
        // the handler's resubmitted logic (its legal next state).
        const prev = (curSub.review_status ?? null) as ReviewStatus | null
        if (prev === 'approved' || prev === 'reopened') {
          const history = Array.isArray(curSub.review_history) ? curSub.review_history : []
          history.push(buildReviewHistoryEntry({
            from: prev,
            to: 'submitted',
            at: nowIso,
            by: contact_id ? `client:${contact_id}` : 'portal',
            note: 'Client edited data — approval invalidated at submit time',
          }))
          await supabaseAdmin
            .from('tax_return_submissions')
            .update({ review_status: 'submitted', review_history: history })
            .eq('id', curSub.id)
            .eq('review_status', prev)
        }
      } else {
        // ── FRESH SUBMISSION ──
        // Token: unique per (person, SUBJECT, filing period) — the legacy
        // name+calendar-year shape let one owner's second company OVERWRITE
        // the first company's submission via the token upsert (proven live,
        // 2026-07-16 E2E walk). See lib/portal/submission-token.ts.
        submissionToken = buildSubmissionToken({
          clientName,
          wizardType: wizard_type,
          taxYear,
          accountId: account_id || null,
          leadId: lead_id || null,
          contactId: contact_id || null,
          calendarYear: new Date().getFullYear(),
          explicitScopeId: closureServiceDeliveryId,
        })

        // The submission tables do NOT share one column set (formation has no
        // account_id, tax_return has no lead_id, itin/closure have no entity_type,
        // only tax_return has tax_year). buildSubmissionRecord centralizes those
        // per-table rules; tests/unit/submission-record.test.ts cross-checks the
        // columns it can emit against the generated DB types, so a future drift
        // fails CI loudly instead of as a 500 / false "submission failed" toast.
        const submissionRecord = buildSubmissionRecord(submissionTable, {
          token: submissionToken,
          contact_id: contact_id || null,
          account_id: account_id || null,
          lead_id: lead_id || null,
          entity_type: entity_type || null,
          submitted_data: data,
          upload_paths: uploadPaths,
          tax_year: taxYear,
        })

        // Never undo a completed review. The upsert keys on `token`, and a
        // formation token is stable for the same person + lead + calendar year,
        // so a re-submit lands on the SAME row and would reset its status from
        // "reviewed" back to "completed" (dev job ca788354). Preserving it here
        // costs one read and is safe either way: a legitimate continuation is
        // re-marked "reviewed" by the background handler seconds later.
        const { data: priorSub } = await supabaseAdmin
          .from(submissionTable as never)
          .select('status')
          .eq('token', submissionToken)
          .maybeSingle()
        const recordToWrite = preserveReviewedStatus(
          submissionRecord,
          (priorSub as { status?: string | null } | null)?.status ?? null,
        )

        const { data: sub, error: subErr } = await supabaseAdmin
          .from(submissionTable as never)
          .upsert(recordToWrite as never, { onConflict: 'token' })
          .select('id')
          .single()

        if (subErr) {
          // Do NOT silently continue. Previously this just logged and let
          // submissionId stay null, which caused the background handler to
          // bail with "invalid payload" and the client to see "submitted
          // successfully" while the auto-chain never ran. Fail loudly so the
          // client retries and so the error is visible in logs.
          console.error('[wizard-submit] Submission upsert failed:', subErr.message)
          return NextResponse.json(
            { error: `Failed to save submission: ${subErr.message}` },
            { status: 500 },
          )
        }
        submissionId = (sub as Record<string, unknown> | null)?.id as string || null

        // Mark the tax submission "submitted" SYNCHRONOUSLY on first submit so the
        // portal banner reads "submitted — under review" the instant the client
        // lands back on the dashboard. The background handler (tax-form-setup
        // step 9) otherwise sets review_status a few seconds later, leaving the
        // client briefly on the "Complete your tax form" banner and prone to
        // re-submitting (Luca, 2026-06-25). Guarded to review_status IS NULL so a
        // resubmit-after-revision is left untouched for the handler's
        // submitted/resubmitted logic; the handler still appends review_history.
        if ((wizard_type === 'tax' || wizard_type === 'tax_return') && submissionId) {
          await supabaseAdmin
            .from('tax_return_submissions')
            .update({ review_status: 'submitted' })
            .eq('id', submissionId)
            .is('review_status', null)
        }
      }

      // Prior-year return matrix (tax wizard, master plan §5): resolve the
      // client's answer — verify Case A against our records, extract+validate
      // a Case-B upload, cross-check Case C vs formation date, store the
      // Case-D declaration / spawn the back-filing quote task. Fire-and-forget:
      // a failure here never blocks the submission.
      if (
        (wizard_type === 'tax' || wizard_type === 'tax_return') &&
        submissionId && account_id && taxYear !== null &&
        data.prior_return_case
      ) {
        const capturedSubmissionId = submissionId
        const capturedTaxYear = taxYear
        void import('@/lib/tax/prior-return-case')
          .then(({ processPriorReturnCase }) => processPriorReturnCase({
            submissionId: capturedSubmissionId,
            accountId: account_id,
            taxYear: capturedTaxYear,
            submittedData: data,
            uploadPaths,
          }))
          .catch(e => console.error('[wizard-submit] Prior-return case processing failed:', e))
      }

      // Bank statements → ingest jobs, enqueued SYNCHRONOUSLY here (not only
      // from the fire-and-forget tax_form_setup handler, which can be killed
      // mid-run before reaching its enqueue step — leaving statements accepted
      // but never read, P&L stuck at $0). Idempotent: a file already queued is
      // skipped, so the handler's backstop call never double-processes a PDF.
      // (Luca / Dynamiq, 2026-06-26.)
      if ((wizard_type === 'tax' || wizard_type === 'tax_return') && account_id && taxYear !== null) {
        try {
          const { enqueueStatementIngestJobs } = await import('@/lib/tax/statement-ingest-enqueue')
          const { enqueued } = await enqueueStatementIngestJobs({
            accountId: account_id,
            taxYear,
            uploadPaths,
            submittedData: data,
            createdBy: 'portal_wizard',
          })
          if (enqueued > 0) console.warn(`[wizard-submit] Queued ${enqueued} statement ingest job(s) synchronously`)
        } catch (e) {
          console.error('[wizard-submit] Statement ingest enqueue failed:', e)
        }
      }

      // Google-Drive archival → durable job, enqueued SYNCHRONOUSLY here for the
      // same reason as the ingest jobs above: the fire-and-forget tax_form_setup
      // handler can be killed before its own (best-effort) copy runs, and its
      // inline copy has no retry. This durable job self-heals and owns the
      // drive_archived_at marker; the backstop sweep catches anything still
      // un-archived. Idempotent — a non-failed archive job for this submission
      // is skipped. (Carasso Drive-reliability, 2026-07-24.)
      if ((wizard_type === 'tax' || wizard_type === 'tax_return') && submissionId && account_id) {
        try {
          const { enqueueTaxArchiveJob } = await import('@/lib/tax/archive-enqueue')
          await enqueueTaxArchiveJob({ submissionId, accountId: account_id, createdBy: 'portal_wizard' })
        } catch (e) {
          console.error('[wizard-submit] Drive archive enqueue failed:', e)
        }
      }
    }

    // ─── 4b. BANKING WIZARD — fire-and-forget background work, return immediately ───
    // wizard_progress is already saved as 'submitted' in step 2. Return success
    // to the client right away — Drive PDF, notifications, CRM task, and SD
    // stage advance all run in the background. This prevents false-negative
    // "Invio fallito" errors caused by slow Drive API calls or connection drops
    // while the server was still processing (data was already persisted).
    if (wizard_type === 'banking_payset' || wizard_type === 'banking_relay') {
      const provider = wizard_type === 'banking_relay' ? 'Relay (USD)' : 'Payset (EUR)'
      const capturedData = data
      const capturedAccountId = account_id
      const capturedContactId = contact_id
      const capturedWizardType = wizard_type
      const capturedProgressId = progress_id
      const capturedCompanyName = companyName
      const providerSlug = capturedWizardType === 'banking_relay' ? 'relay' : 'payset'

      // Fire-and-forget: Drive PDF, portal chat, CRM task, SD advance, action_log
      ;(async () => {
        // Get account Drive folder — wrapped so any throw stays in background
        let driveFolderId: string | null = null
        let compName = capturedCompanyName
        if (capturedAccountId) {
          try {
            const { data: acct } = await supabaseAdmin
              .from('accounts')
              .select('drive_folder_id, company_name')
              .eq('id', capturedAccountId)
              .single()
            driveFolderId = acct?.drive_folder_id ?? null
            if (!compName) compName = acct?.company_name ?? ''
          } catch (e) {
            console.error('[wizard-submit] Banking accounts query error:', e)
          }
        }

        // Generate PDF + save to Drive
        if (driveFolderId) {
          try {
            const { saveFormToDrive } = await import('@/lib/form-to-drive')
            const uploadPaths = extractUploadPaths(capturedData)
            const result = await saveFormToDrive(capturedWizardType, capturedData, uploadPaths, driveFolderId, {
              token: submissionToken || capturedWizardType,
              submittedAt: new Date().toISOString(),
              companyName: compName,
            })

            // Create document record for the summary PDF. Routed through
            // autoSaveDocument (2026-07-07) so the row gets a drive_link
            // (the raw insert here produced "No link" rows in the CRM
            // Documents tab) and so a resubmit can't insert a second row
            // for the same Drive file (the upsert save keeps the id stable;
            // autoSaveDocument dedupes on drive_file_id).
            if (result.summaryFileId) {
              const slug = compName.replace(/\s+/g, '_')
              const { autoSaveDocument } = await import('@/lib/portal/auto-save-document')
              const saved = await autoSaveDocument({
                accountId: capturedAccountId || undefined,
                contactId: capturedContactId || undefined,
                fileName: `Banking_${capturedWizardType === 'banking_relay' ? 'Relay' : 'Payset'}_${slug}.pdf`,
                documentType: 'Banking Application',
                category: 4, // Banking
                driveFileId: result.summaryFileId,
                portalVisible: false,
              })
              if (saved.error) {
                console.error('[wizard-submit] Banking document record error:', saved.error)
              }
            }
          } catch (e) {
            console.error('[wizard-submit] Banking PDF/Drive error:', e)
          }
        }

        // Portal chat notification — message to the account. Left exactly as-is:
        // this is client-visible (no chat-event marker), and any marker-carrying
        // message is hidden from the client's own chat view (app/api/portal/chat/
        // route.ts) — converting this into a marked note would silently remove
        // a confirmation the client can see today.
        if (capturedAccountId) {
          try {
            await supabaseAdmin.from('portal_messages').insert({
              account_id: capturedAccountId,
              sender_type: 'system',
              sender_id: '00000000-0000-0000-0000-000000000000',
              message: `Banking application submitted: ${provider}. Our team will review and submit it on your behalf.`,
            })
          } catch (e) {
            console.error('[wizard-submit] Chat notification error:', e)
          }
        }

        // Staff-only notifications (dev job fb527ac8): What's New chat note +
        // Notification Center card. A SEPARATE write from the client-visible
        // note above, on purpose (see comment above). Looks up the existing
        // banking_submissions row (normally pre-seeded at onboarding, but not
        // guaranteed — see the "no row found" case a few blocks below) so both
        // notifications carry a stable source id. Hardened against duplicate
        // rows for the same account+provider (no unique constraint on that
        // pair) via order+limit before maybeSingle. If the row was ALREADY
        // 'completed' before this submission, this is a resubmission — retire
        // the old chat-event note first so the dedup marker doesn't swallow
        // the new one.
        let bankingSubmissionId: string | null = null
        let bankingSubmissionWasAlreadyCompleted = false
        if (capturedAccountId) {
          try {
            const { data: subRow } = await supabaseAdmin
              .from('banking_submissions')
              .select('id, status')
              .eq('account_id', capturedAccountId)
              .eq('provider', providerSlug)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (subRow) {
              bankingSubmissionId = subRow.id
              bankingSubmissionWasAlreadyCompleted = subRow.status === 'completed'
            } else {
              // Safety net (dev job c3efa6cb): the row is normally pre-seeded
              // when the EIN is recorded, but at least 3 distinct upstream
              // causes can skip that — create it now via the SAME shared
              // helper the seeding job uses (lib/operations/banking-submission.ts),
              // rather than the notification code silently giving up. This
              // never sends anything client-facing; it only creates the
              // record the alerts below key off of.
              const { getOrCreateBankingSubmission } = await import('@/lib/operations/banking-submission')
              const created = await getOrCreateBankingSubmission({ accountId: capturedAccountId, provider: providerSlug, contactId: capturedContactId ?? null })
              if (created.outcome === 'ok') {
                bankingSubmissionId = created.record.id
                bankingSubmissionWasAlreadyCompleted = created.record.status === 'completed'
              } else {
                console.error(`[wizard-submit] could not create banking_submissions row for account ${capturedAccountId} provider ${providerSlug}: ${created.message} — staff notifications NOT sent (client confirmation above still sent)`)
              }
            }
          } catch (e) {
            console.error('[wizard-submit] banking_submissions lookup error (staff notifications):', e)
          }
        }

        if (capturedAccountId && bankingSubmissionId) {
          try {
            const { emitBankingWizardSubmittedEvent, retireBankingWizardSubmittedNote } = await import('@/lib/portal/chat-events')
            if (bankingSubmissionWasAlreadyCompleted) {
              await retireBankingWizardSubmittedNote({ bankingSubmissionId })
            }
            await emitBankingWizardSubmittedEvent({
              banking_submission_id: bankingSubmissionId,
              account_id: capturedAccountId,
              contact_id: capturedContactId ?? null,
              provider,
              is_resubmission: bankingSubmissionWasAlreadyCompleted,
            })
            const { emitActionNeeded } = await import('@/lib/notifications/act-event')
            await emitActionNeeded({
              event: providerSlug === 'relay' ? 'banking_wizard_submitted_relay' : 'banking_wizard_submitted_payset',
              account_id: capturedAccountId,
              contact_id: capturedContactId ?? null,
              source_ref: `banking_submissions:${bankingSubmissionId}`,
            })
          } catch (e) {
            console.error('[wizard-submit] Staff notification error:', e)
          }
        }

        // CRM task for staff — idempotent: skip if a task for this provider already exists
        if (capturedAccountId) {
          try {
            const taskTitle = `Review banking application (${provider}) — ${compName}`
            const { data: existingTask } = await supabaseAdmin
              .from('tasks')
              .select('id')
              .eq('account_id', capturedAccountId)
              .eq('task_title', taskTitle)
              .neq('status', 'Done')
              .limit(1)
              .maybeSingle()

            if (!existingTask) {
              // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
              await supabaseAdmin.from('tasks').insert({
                task_title: taskTitle,
                assigned_to: 'Luca',
                status: 'To Do',
                priority: 'High',
                category: 'KYC',
                description: `Client submitted ${provider} banking application via portal wizard. Review the data and submit to the provider.`,
                account_id: capturedAccountId,
                created_by: 'System',
              })
            }
          } catch (e) {
            console.error('[wizard-submit] Task creation error:', e)
          }
        }

        // Advance Banking Fintech service delivery: Data Collection → Application Submitted
        if (capturedAccountId) {
          try {
            const { data: sd } = await supabaseAdmin
              .from('service_deliveries')
              .select('id, stage, stage_history')
              .eq('account_id', capturedAccountId)
              .eq('service_type', 'Banking Fintech')
              .eq('status', 'active')
              .limit(1)
              .maybeSingle()

            if (sd && sd.stage === 'Data Collection') {
              const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
              history.push({
                event: 'banking_wizard_submitted',
                at: new Date().toISOString(),
                note: `${provider} banking form submitted via portal wizard`,
              })
              // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
              await supabaseAdmin
                .from('service_deliveries')
                .update({ stage: 'Application Submitted', stage_history: history, updated_at: new Date().toISOString() })
                .eq('id', sd.id)
            }
          } catch (e) {
            console.error('[wizard-submit] SD advance error:', e)
          }
        }

        // Update banking_submissions record so MCP tools see current data.
        // Updates BY PRIMARY KEY when the id is already known from the staff-
        // notification lookup above (unconditionally single-row regardless of
        // duplicate account+provider rows); falls back to the original
        // account_id+provider match only when that lookup didn't find a row —
        // i.e. today's exact prior behavior for that rare edge case.
        if (capturedAccountId) {
          try {
            const updateQuery = supabaseAdmin
              .from('banking_submissions')
              .update({
                submitted_data: capturedData,
                status: 'completed',
                updated_at: new Date().toISOString(),
              })
            const { data: updatedRow } = await (
              bankingSubmissionId
                ? updateQuery.eq('id', bankingSubmissionId)
                : updateQuery.eq('account_id', capturedAccountId).eq('provider', providerSlug)
            )
              .select('id')
              .maybeSingle()

            // Durable backstop (2026-07-24): the inline Drive save above is
            // best-effort. Enqueue the reliable archive job with the plan PINNED
            // — the wizard uploads to "onboarding-uploads" and this update does
            // NOT persist upload_paths on the row, so we pin the paths (from the
            // submitted data) + folder + config here so the durable job never
            // re-guesses. config = the wizard type (banking_payset|banking_relay).
            if (updatedRow?.id && driveFolderId) {
              try {
                const { enqueueFormArchiveJob } = await import('@/lib/forms/archive-enqueue')
                await enqueueFormArchiveJob({
                  formType: 'banking',
                  submissionId: updatedRow.id,
                  pin: {
                    folderId: driveFolderId,
                    bucket: 'onboarding-uploads',
                    configKey: capturedWizardType,
                    uploadPaths: extractUploadPaths(capturedData),
                    companyName: compName || undefined,
                  },
                  createdBy: 'banking_wizard_submit',
                })
              } catch (e) {
                console.error('[wizard-submit] banking archive enqueue error:', e)
              }
            } else if (!updatedRow?.id) {
              // No banking_submissions row for this account+provider — the durable
              // archival layer has nothing to attach to (only the inline best-
              // effort save above covers it). Rare (the row is normally seeded at
              // onboarding), but log it loudly rather than drop silently.
              console.error(`[wizard-submit] no banking_submissions row for account ${capturedAccountId} provider ${providerSlug} — durable archival NOT enqueued (inline save only)`)
            }
          } catch (e) {
            console.error('[wizard-submit] banking_submissions update error:', e)
          }
        }

        // Log to action_log for CRM Recent Activity feed
        try {
          await supabaseAdmin.from('action_log').insert({
            actor: 'portal_wizard',
            action_type: 'form_submitted',
            table_name: 'wizard_progress',
            record_id: capturedProgressId || null,
            account_id: capturedAccountId || null,
            summary: `Banking application submitted: ${provider} — ${compName}`,
            details: { wizard_type: capturedWizardType, provider },
          })
        } catch (e) {
          console.error('[wizard-submit] action_log error:', e)
        }
      })().catch(err => console.error('[wizard-submit] Banking background task error:', err))

      // Return success immediately — data is already persisted in wizard_progress (step 2)
      return NextResponse.json({ success: true, provider: wizard_type })
    }

    // ─── 4c. TD COMMUNICATION BRAND AUDIT — inline, return immediately ───
    // No submission table / no background job: the td_comm_enrollments row IS
    // the canonical record. Find-or-create it by the client's identity, store
    // the answers, advance status → form_submitted, and announce in the project
    // chat. Done SYNCHRONOUSLY (unlike banking) because this write is the whole
    // point of the submission — a failure must surface to the client (R099),
    // not be lost to a fire-and-forget. wizard_progress is marked submitted only
    // AFTER this succeeds (deferred in step 2) so a retry re-runs cleanly.
    if (wizard_type === 'td_communication') {
      const accountIds =
        identity.kind === 'contact'
          ? identity.accountIds
          : identity.kind === 'teammate'
            ? [identity.accountId]
            : []
      const {
        submitBrandAudit,
        normalizeClientType,
        businessNameFromFormData,
      } = await import('@/lib/td-communication/brand-audit')
      const clientType = normalizeClientType(entity_type)
      try {
        const { enrollmentId } = await submitBrandAudit({
          contactId: contact_id || (identity.kind === 'contact' ? identity.contactId : null),
          subjectAccountId: account_id || null,
          accountIds,
          clientType,
          formData: data as Record<string, unknown>,
        })

        // Enrollment write succeeded → now mark wizard_progress submitted.
        const tdWpResult = await markWizardProgressSubmitted({
          progressId: progress_id || null,
          wizardType: wizard_type,
          data,
          accountId: account_id || null,
          contactId: contact_id || null,
          leadId: lead_id || null,
        })
        if (tdWpResult.error) {
          // The enrollment itself already succeeded — don't fail the
          // client's submission over the tracking row, but don't let it
          // vanish silently either (dev job 9a9c5cf5).
          console.error('[wizard-submit] TD Comm wizard_progress write failed:', tdWpResult.error.message)
          reportSystemError({
            source: 'server',
            route: '/api/portal/wizard-submit',
            method: 'POST',
            message: `wizard_progress write failed for wizard_type=td_communication (enrollment ${enrollmentId} still succeeded): ${tdWpResult.error.message}`,
            context: { wizard_type, contact_id, account_id, enrollment_id: enrollmentId },
          }).catch(() => {})
        }

        // action_log for the CRM Recent Activity feed (mirror banking).
        try {
          await supabaseAdmin.from('action_log').insert({
            actor: 'portal_wizard',
            action_type: 'form_submitted',
            table_name: 'td_comm_enrollments',
            record_id: enrollmentId,
            account_id: account_id || null,
            summary: `Brand audit submitted: ${businessNameFromFormData(data as Record<string, unknown>)}`,
            details: { wizard_type, client_type: clientType },
          })
        } catch (e) {
          console.error('[wizard-submit] Brand audit action_log error:', e)
        }

        return NextResponse.json({ success: true, enrollment_id: enrollmentId })
      } catch (e) {
        console.error('[wizard-submit] Brand audit submit failed:', e instanceof Error ? e.message : e)
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Brand audit submit failed' },
          { status: 500 },
        )
      }
    }

    // ─── 5. ENQUEUE BACKGROUND JOB (Auto-Chain) ───
    const jobType = getJobType(wizard_type)
    let jobId: string | null = null

    if (jobType && submissionToken) {
      // Fetch state_of_formation for the payload
      let stateOfFormation = data.state_of_formation || ''
      if (!stateOfFormation && account_id) {
        const { data: acct } = await supabaseAdmin
          .from('accounts')
          .select('state_of_formation')
          .eq('id', account_id)
          .single()
        stateOfFormation = acct?.state_of_formation || ''
      }

      // Build payload matching what the handler expects
      const payload: Record<string, unknown> = {
        token: submissionToken,
        submission_id: submissionId,
        account_id: account_id || null,
        contact_id: contact_id || null,
        lead_id: lead_id || null, // Formation-for-new-company carries its lead for materialization
        company_name: companyName,
        state_of_formation: stateOfFormation,
        // NULL, never 'SMLLC', when genuinely unknown. The materializer resolves
        // entity type from the signed contract and treats this only as a
        // lower-priority hint; a fabricated default here used to let a guess
        // masquerade as evidence. See lib/portal/submission-record.ts.
        entity_type: entity_type || null,
        submitted_data: data,
        upload_paths: extractUploadPaths(data),
        // Portal-specific: signals this came from the portal wizard (not MCP review)
        source: 'portal_wizard',
        // Closure only (dev job fbbf4abe): the specific, server-verified
        // record this submission belongs to. Lets closure-form-completed
        // look this up by the exact record instead of guessing from
        // account/contact — see lib/portal/closure-subject.ts.
        service_delivery_id: closureServiceDeliveryId,
      }

      // For tax wizard, carry the PINNED year + tax_returns row from the
      // eligibility resolver so the handler never re-derives them (its old
      // any-row / calendar fallbacks attributed data to wrong years).
      if (wizard_type === 'tax' || wizard_type === 'tax_return') {
        payload.tax_return_id = taxEligibility?.taxReturnId ?? null
        payload.tax_year = taxEligibility?.taxYear ?? null
        payload.changed_fields = null // Portal wizard doesn't track diffs
      }

      // Duplicate-submission guard (LT Program incident 2026-07-07): a client
      // retrying the same submit must NOT enqueue a twin job — reuse the
      // recent one. A resubmission with any changed field hashes differently
      // and enqueues normally. See lib/portal/wizard-job-dedupe.ts.
      const { buildWizardJobDedupeKey, findRecentDuplicateJob } = await import('@/lib/portal/wizard-job-dedupe')
      const dedupeKey = buildWizardJobDedupeKey({
        wizardType: wizard_type,
        accountId: account_id,
        contactId: contact_id,
        leadId: lead_id,
        data,
      })
      payload.dedupe_key = dedupeKey

      const duplicate = await findRecentDuplicateJob(jobType, dedupeKey)
      if (duplicate) {
        jobId = duplicate.id
        console.warn(`[wizard-submit] Duplicate ${jobType} submit for ${clientName} — reusing job ${jobId} (status: ${duplicate.status})`)
      } else {
        const job = await enqueueJob({
          job_type: jobType,
          payload,
          priority: 3, // Higher priority than default (lower number = higher)
          account_id: account_id || undefined,
          created_by: 'portal',
        })

        jobId = job.id
        console.warn(`[wizard-submit] Enqueued ${jobType} job ${jobId} for ${clientName}`)
      }

      // ─── 5. DEFERRED WIZARD_PROGRESS WRITE ───
      // Every type that reaches this block (everything except banking,
      // handled early at step 2, and td_communication, deferred inside its
      // own branch) marks wizard_progress 'submitted' HERE — after the
      // submission is durably saved (step 4) AND the background job is
      // enqueued — never before. If anything above this point failed, the
      // request already returned (submission save) or threw (enqueue), so
      // this line is never reached and wizard_progress correctly stays
      // NOT 'submitted' for a retry to pick up cleanly.
      //
      // FAIL LOUD on the write itself: a retry after THIS specific failure
      // is safe (not a duplicate risk) — the submission-table upsert is
      // token-keyed (idempotent) and the job enqueue above is deduped by
      // content hash (findRecentDuplicateJob), so re-running the whole
      // route just re-attempts this one write and converges.
      const wpResult = await markWizardProgressSubmitted({
        progressId: progress_id || null,
        wizardType: wizard_type,
        data,
        accountId: account_id || null,
        contactId: contact_id || null,
        leadId: lead_id || null,
        serviceDeliveryId: closureServiceDeliveryId,
      })
      if (wpResult.error) {
        console.error('[wizard-submit] wizard_progress write failed (post-enqueue):', wpResult.error.message)
        reportSystemError({
          source: 'server',
          route: '/api/portal/wizard-submit',
          method: 'POST',
          message: `wizard_progress write failed for wizard_type=${wizard_type} (job ${jobId} already enqueued): ${wpResult.error.message}`,
          context: { wizard_type, contact_id, account_id, job_id: jobId },
        }).catch(() => {})
        return NextResponse.json(
          { error: 'Your submission was saved, but we could not confirm it. Please submit again to be sure.' },
          { status: 500 },
        )
      }
    }

    // ─── 6. FIRE-AND-FORGET EXECUTION (for tax jobs) ───
    // Data is already saved (step 2 + step 4). Return success immediately so the
    // client gets a clean confirmation screen regardless of how long the handler
    // takes. The handler runs in the background; the client gets a portal message
    // when it completes (step 10 of handleTaxFormSetup). Cron at
    // /api/cron/process-jobs acts as safety net if the background task fails.
    if (jobType === 'tax_form_setup' && jobId) {
      const capturedJobId = jobId

      ;(async () => {
        const claimNow = new Date().toISOString()
        const { data: claimedJob } = await supabaseAdmin
          .from('job_queue')
          .update({ status: 'processing', started_at: claimNow, attempts: 1 })
          .eq('id', capturedJobId)
          .eq('status', 'pending')
          .select('*')
          .single()

        if (!claimedJob) {
          console.warn(`[wizard-submit] Tax job ${capturedJobId} already claimed by worker — skipping background execution`)
          return
        }

        try {
          const { handleTaxFormSetup } = await import('@/lib/jobs/handlers/tax-form-setup')
          const result = await handleTaxFormSetup(claimedJob as unknown as Job)
          if (result.ok === false) {
            await failJob(capturedJobId, result.summary || 'Handler reported failure', result)
            console.warn(`[wizard-submit] Tax job ${capturedJobId} background-completed as failed: ${result.summary}`)
          } else {
            await completeJob(capturedJobId, result)
            console.warn(`[wizard-submit] Tax job ${capturedJobId} completed in background: ${result.summary}`)
          }
        } catch (handlerErr) {
          const errMsg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr)
          await failJob(capturedJobId, errMsg)
          console.error(`[wizard-submit] Tax job ${capturedJobId} failed in background:`, errMsg)
        }
      })().catch(err => console.error('[wizard-submit] Tax background task error:', err))
    }

    // ─── 7. FIRE-AND-FORGET EXECUTION (for closure jobs) ───
    // Same hybrid shape as step 6: the job is already durably enqueued (step 5),
    // so this is purely a speed optimization — if the platform kills this
    // function before the claim below even runs, the job just sits 'pending'
    // and the /api/cron/process-jobs safety net (every 5 minutes) picks it up
    // and runs the exact same handler later. Dev job fbbf4abe.
    if (jobType === 'closure_setup' && jobId) {
      const capturedJobId = jobId

      ;(async () => {
        const claimNow = new Date().toISOString()
        const { data: claimedJob } = await supabaseAdmin
          .from('job_queue')
          .update({ status: 'processing', started_at: claimNow, attempts: 1 })
          .eq('id', capturedJobId)
          .eq('status', 'pending')
          .select('*')
          .single()

        if (!claimedJob) {
          console.warn(`[wizard-submit] Closure job ${capturedJobId} already claimed by worker — skipping background execution`)
          return
        }

        try {
          const { handleClosureSetup } = await import('@/lib/jobs/handlers/closure-setup')
          const result = await handleClosureSetup(claimedJob as unknown as Job)
          if (result.ok === false) {
            await failJob(capturedJobId, result.summary || 'Handler reported failure', result)
            console.warn(`[wizard-submit] Closure job ${capturedJobId} background-completed as failed: ${result.summary}`)
          } else {
            await completeJob(capturedJobId, result)
            console.warn(`[wizard-submit] Closure job ${capturedJobId} completed in background: ${result.summary}`)
          }
        } catch (handlerErr) {
          const errMsg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr)
          await failJob(capturedJobId, errMsg)
          console.error(`[wizard-submit] Closure job ${capturedJobId} failed in background:`, errMsg)
        }
      })().catch(err => console.error('[wizard-submit] Closure background task error:', err))
    }

    return NextResponse.json({
      success: true,
      job_id: jobId,
      token: submissionToken,
    })
  } catch (err) {
    console.error(
      '[wizard-submit] Error:',
      err instanceof Error ? err.message : err,
      err instanceof Error ? err.stack : '',
    )
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Submit failed' },
      { status: 500 }
    )
  }
}
