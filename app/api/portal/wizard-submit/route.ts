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
import { getSubmissionTable, getJobType } from '@/lib/portal/wizard-map'
import { buildSubmissionRecord } from '@/lib/portal/submission-record'
import { accountIdForWizardSubmission } from '@/lib/portal/wizard-scope'
import { validateWizardData } from '@/lib/jobs/validation'
import { collectUploadPaths } from '@/lib/portal/wizard-uploads'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { canSubmitWizard } from '@/lib/portal/wizard-submit-access'
import { formationLeadOwned } from '@/lib/portal/formation-lead-access'

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
  const { wizard_type, entity_type, data, account_id: rawAccountId, contact_id, lead_id, progress_id, allow_resubmit } = body

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

  // TEMP RESUBMIT-DEBUG (remove after capture) — dev_task b2115fd3.
  // Captures the exact failure point of the tax "Edit & re-submit" path. Gated
  // on allow_resubmit so normal first-time submissions stay quiet.
  if (allow_resubmit) {
    console.warn('[RESUBMIT-DEBUG] entry', JSON.stringify({
      wizard_type,
      entity_type: entity_type ?? null,
      progress_id: progress_id ?? null,
      account_id: account_id ?? null,
      contact_id: contact_id ?? null,
      lead_id: lead_id ?? null,
      has_data: !!data,
    }))
  }

  // ─── 0a. ISOLATION GUARD (default-deny) ───
  // The logged-in user must be allowed to submit for this subject. Without this
  // the route trusted the body's account_id / contact_id, so a member of one
  // company could tamper account_id to another company they aren't linked to and
  // submit wizard data onto it. Mirrors the access checks on the other portal
  // routes (chat / payment-links / customers). dev_task b41cc66f.
  const identity = await resolvePortalIdentity(user)
  if (!canSubmitWizard(identity, account_id, contact_id ?? null)) {
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

  // ─── 0. SYNCHRONOUS VALIDATION ───
  // Structural fix: validate at the route boundary so the client sees field
  // errors inline. Previously validation ran inside the background handler,
  // where failures were invisible to the browser (the API had already
  // returned 200 success). The client retried blindly, flooding the queue
  // with duplicate jobs. See dev_task 3d6800c8 for the Luca Gallacci case
  // that motivated this fix.
  const validation = validateWizardData(wizard_type, data as Record<string, unknown>)
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
    // For company_info: deferred until AFTER job enqueue succeeds (scoped reorder).
    // All other wizard types: mark submitted immediately (existing behavior).
    if (wizard_type !== 'company_info') {
      if (progress_id) {
        await supabaseAdmin
          .from('wizard_progress')
          .update({
            data,
            status: 'submitted',
            updated_at: new Date().toISOString(),
          })
          .eq('id', progress_id)
      } else {
        await supabaseAdmin
          .from('wizard_progress')
          .insert({
            wizard_type,
            data,
            account_id: account_id || null,
            contact_id: contact_id || null,
            lead_id: lead_id || null,
            status: 'submitted',
            current_step: 99,
          })
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
      const nameSlug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 40)
      submissionToken = `portal-${nameSlug}-${new Date().getFullYear()}`

      const uploadPaths = extractUploadPaths(data)

      // For tax submissions, look up tax_year from tax_returns (required field)
      let taxYear: number | null = null
      if ((wizard_type === 'tax' || wizard_type === 'tax_return') && account_id) {
        const { data: tr } = await supabaseAdmin
          .from('tax_returns')
          .select('tax_year')
          .eq('account_id', account_id)
          .eq('data_received', false)
          .order('tax_year', { ascending: false })
          .limit(1)
          .maybeSingle()
        taxYear = tr?.tax_year ?? null
      }

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

      const { data: sub, error: subErr } = await supabaseAdmin
        .from(submissionTable as never)
        .upsert(submissionRecord as never, { onConflict: 'token' })
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

      // TEMP RESUBMIT-DEBUG (remove after capture) — dev_task b2115fd3.
      if (allow_resubmit) {
        console.warn('[RESUBMIT-DEBUG] submission upsert OK', JSON.stringify({
          submissionTable,
          submissionToken,
          submissionId,
        }))
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

            // Create document record for the summary PDF
            if (result.summaryFileId) {
              const slug = compName.replace(/\s+/g, '_')
              await supabaseAdmin.from('documents').insert({
                file_name: `Banking_${capturedWizardType === 'banking_relay' ? 'Relay' : 'Payset'}_${slug}.pdf`,
                drive_file_id: result.summaryFileId,
                document_type_name: 'Banking Application',
                category: 4, // Banking
                confidence: 'high',
                status: 'classified',
                account_id: capturedAccountId || null,
                contact_id: capturedContactId || null,
              })
            }
          } catch (e) {
            console.error('[wizard-submit] Banking PDF/Drive error:', e)
          }
        }

        // Portal chat notification — message to the account
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

        // Update banking_submissions record so MCP tools see current data
        if (capturedAccountId) {
          try {
            const providerSlug = capturedWizardType === 'banking_relay' ? 'relay' : 'payset'
            await supabaseAdmin
              .from('banking_submissions')
              .update({
                submitted_data: capturedData,
                status: 'completed',
                updated_at: new Date().toISOString(),
              })
              .eq('account_id', capturedAccountId)
              .eq('provider', providerSlug)
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
        entity_type: entity_type || 'SMLLC',
        submitted_data: data,
        upload_paths: extractUploadPaths(data),
        // Portal-specific: signals this came from the portal wizard (not MCP review)
        source: 'portal_wizard',
      }

      // For tax wizard, add tax-specific fields
      if (wizard_type === 'tax' || wizard_type === 'tax_return') {
        payload.tax_return_id = null // Handler will look up from account
        payload.changed_fields = null // Portal wizard doesn't track diffs
      }

      // TEMP RESUBMIT-DEBUG (remove after capture) — dev_task b2115fd3.
      // enqueueJob is the prime re-submit suspect: the data writes above have
      // already succeeded, so a throw here gives "data saved but the client saw
      // an error". Capture the precise failure before re-throwing into the
      // shared catch.
      let job
      try {
        job = await enqueueJob({
          job_type: jobType,
          payload,
          priority: 3, // Higher priority than default (lower number = higher)
          account_id: account_id || undefined,
          created_by: 'portal',
        })
      } catch (e) {
        console.error('[RESUBMIT-DEBUG] enqueueJob threw', JSON.stringify({
          allow_resubmit: !!allow_resubmit,
          wizard_type,
          jobType,
          submissionToken,
          account_id: account_id ?? null,
          message: e instanceof Error ? e.message : String(e),
        }), e instanceof Error ? e.stack : '')
        throw e
      }

      jobId = job.id
      console.warn(`[wizard-submit] Enqueued ${jobType} job ${jobId} for ${clientName}`)

      // company_info scoped reorder: mark wizard_progress as submitted AFTER job enqueue succeeds.
      // If enqueue failed (threw above), this never runs — portal shows company_info wizard for retry.
      if (wizard_type === 'company_info') {
        if (progress_id) {
          await supabaseAdmin
            .from('wizard_progress')
            .update({
              data,
              status: 'submitted',
              updated_at: new Date().toISOString(),
            })
            .eq('id', progress_id)
        } else {
          await supabaseAdmin
            .from('wizard_progress')
            .insert({
              wizard_type,
              data,
              account_id: account_id || null,
              contact_id: contact_id || null,
              lead_id: lead_id || null,
              status: 'submitted',
              current_step: 99,
            })
        }
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

    return NextResponse.json({
      success: true,
      job_id: jobId,
      token: submissionToken,
    })
  } catch (err) {
    // TEMP RESUBMIT-DEBUG (remove after capture) — dev_task b2115fd3: stack + marker.
    console.error(
      allow_resubmit ? '[RESUBMIT-DEBUG] handler threw' : '[wizard-submit] Error:',
      err instanceof Error ? err.message : err,
      err instanceof Error ? err.stack : '',
    )
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Submit failed' },
      { status: 500 }
    )
  }
}
