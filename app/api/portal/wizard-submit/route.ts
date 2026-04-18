/**
 * POST /api/portal/wizard-submit — Submit completed wizard data.
 *
 * THIN DISPATCHER (Phase 2 Auto-Chain):
 * 1. Saves wizard_progress + submission record (fast, inline)
 * 2. Enqueues a background job for the full auto-chain (non-blocking)
 * 3. Returns immediately so client gets fast response
 *
 * The background job (onboarding_setup / formation_setup / tax_form_setup)
 * handles ALL heavy work: Drive, CRM updates, OA, Lease, Banking, notifications.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'
import { enqueueJob, completeJob, failJob, type Job } from '@/lib/jobs/queue'
import { getSubmissionTable, getJobType } from '@/lib/portal/wizard-map'
import { validateWizardData } from '@/lib/jobs/validation'

/** Extract file upload paths from wizard data.
 * All wizard uploads follow the pattern: {wizardType}/{identifier}/{fieldName}_{filename}
 * stored in the "onboarding-uploads" bucket (see wizard-upload/route.ts:35).
 * Instead of a brittle whitelist of field names, detect any value that looks like a storage path. */
function extractUploadPaths(data: Record<string, unknown>): string[] {
  const WIZARD_PREFIXES = ['formation/', 'onboarding/', 'tax/', 'tax_return/', 'banking/', 'banking_payset/', 'banking_relay/', 'itin/', 'closure/', 'company_info/']
  const paths: string[] = []
  for (const val of Object.values(data)) {
    if (typeof val === 'string' && WIZARD_PREFIXES.some(p => val.startsWith(p))) {
      paths.push(val)
    }
  }
  return paths
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
  const { wizard_type, entity_type, data, account_id, contact_id, progress_id, allow_resubmit } = body

  if (!wizard_type || !data) {
    return NextResponse.json({ error: 'wizard_type and data are required' }, { status: 400 })
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

      const submissionRecord: Record<string, unknown> = {
        token: submissionToken,
        contact_id: contact_id || null,
        account_id: account_id || null,
        entity_type: entity_type || 'SMLLC',
        language: 'en',
        prefilled_data: {},
        submitted_data: data,
        changed_fields: {},
        upload_paths: uploadPaths,
        status: 'completed',
      }

      // Only include lead_id for tables that have it (tax_return_submissions does not)
      if (submissionTable !== 'tax_return_submissions') {
        submissionRecord.lead_id = null
      }

      // Only include tax_year if we resolved it (avoids NOT NULL constraint violation)
      if (taxYear !== null) submissionRecord.tax_year = taxYear

      const { data: sub, error: subErr } = await supabaseAdmin
        .from(submissionTable as never)
        .upsert(submissionRecord as never, { onConflict: 'token' })
        .select('id')
        .single()

      if (subErr) {
        console.error('[wizard-submit] Submission upsert failed:', subErr.message)
      }
      submissionId = (sub as Record<string, unknown> | null)?.id as string || null
    }

    // ─── 4b. BANKING WIZARD — PDF + Drive + Notifications (inline, no background job) ───
    if (wizard_type === 'banking_payset' || wizard_type === 'banking_relay') {
      const provider = wizard_type === 'banking_relay' ? 'Relay (USD)' : 'Payset (EUR)'

      // Get account Drive folder
      let driveFolderId: string | null = null
      let compName = companyName
      if (account_id) {
        const { data: acct } = await supabaseAdmin
          .from('accounts')
          .select('drive_folder_id, company_name')
          .eq('id', account_id)
          .single()
        driveFolderId = acct?.drive_folder_id ?? null
        if (!compName) compName = acct?.company_name ?? ''
      }

      // Generate PDF + save to Drive
      if (driveFolderId) {
        try {
          const { saveFormToDrive } = await import('@/lib/form-to-drive')
          const uploadPaths = extractUploadPaths(data)
          const result = await saveFormToDrive(wizard_type, data, uploadPaths, driveFolderId, {
            token: submissionToken || wizard_type,
            submittedAt: new Date().toISOString(),
            companyName: compName,
          })

          // Create document record for the summary PDF
          if (result.summaryFileId) {
            const slug = compName.replace(/\s+/g, '_')
            await supabaseAdmin.from('documents').insert({
              file_name: `Banking_${wizard_type === 'banking_relay' ? 'Relay' : 'Payset'}_${slug}.pdf`,
              drive_file_id: result.summaryFileId,
              document_type_name: 'Banking Application',
              category: 4, // Banking
              confidence: 'high',
              status: 'classified',
              account_id: account_id || null,
              contact_id: contact_id || null,
            })
          }
        } catch (e) {
          console.error('[wizard-submit] Banking PDF/Drive error:', e)
        }
      }

      // Portal chat notification — message to the account
      if (account_id) {
        try {
          await supabaseAdmin.from('portal_messages').insert({
            account_id,
            sender_type: 'system',
            sender_id: null,
            message: `Banking application submitted: ${provider}. Our team will review and submit it on your behalf.`,
          })
        } catch (e) {
          console.error('[wizard-submit] Chat notification error:', e)
        }
      }

      // CRM task for staff
      if (account_id) {
        try {
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          await supabaseAdmin.from('tasks').insert({
            task_title: `Review banking application (${provider}) — ${compName}`,
            assigned_to: 'Luca',
            status: 'To Do',
            priority: 'High',
            category: 'KYC',
            description: `Client submitted ${provider} banking application via portal wizard. Review the data and submit to the provider.`,
            account_id,
            created_by: 'System',
          })
        } catch (e) {
          console.error('[wizard-submit] Task creation error:', e)
        }
      }

      // Advance Banking Fintech service delivery: Data Collection → Application Submitted
      if (account_id) {
        try {
          const { data: sd } = await supabaseAdmin
            .from('service_deliveries')
            .select('id, stage, stage_history')
            .eq('account_id', account_id)
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
      if (account_id) {
        try {
          const providerSlug = wizard_type === 'banking_relay' ? 'relay' : 'payset'
          await supabaseAdmin
            .from('banking_submissions')
            .update({
              submitted_data: data,
              status: 'completed',
              updated_at: new Date().toISOString(),
            })
            .eq('account_id', account_id)
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
          record_id: progress_id || null,
          account_id: account_id || null,
          summary: `Banking application submitted: ${provider} — ${compName}`,
          details: { wizard_type, provider },
        })
      } catch (e) {
        console.error('[wizard-submit] action_log error:', e)
      }

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
        lead_id: null, // Portal submissions don't have leads
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

      const job = await enqueueJob({
        job_type: jobType,
        payload,
        priority: 3, // Higher priority than default (lower number = higher)
        account_id: account_id || undefined,
        created_by: 'portal',
      })

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
              status: 'submitted',
              current_step: 99,
            })
        }
      }
    }

    // ─── 6. DIRECT HANDLER EXECUTION (for tax jobs) ───
    // Claim and run the handler inline — more reliable than fire-and-forget HTTP.
    // For tax_form_setup: blocks the response until processing completes (~10-30s).
    // If claim fails (worker already picked it up), skip — it will be handled.
    // Cron at /api/cron/process-jobs acts as safety net for anything missed.
    if (jobType === 'tax_form_setup' && jobId) {
      const claimNow = new Date().toISOString()
      const { data: claimedJob } = await supabaseAdmin
        .from('job_queue')
        .update({ status: 'processing', started_at: claimNow, attempts: 1 })
        .eq('id', jobId)
        .eq('status', 'pending')
        .select('*')
        .single()

      if (claimedJob) {
        try {
          const { handleTaxFormSetup } = await import('@/lib/jobs/handlers/tax-form-setup')
          const result = await handleTaxFormSetup(claimedJob as unknown as Job)
          await completeJob(jobId, result)
          console.warn(`[wizard-submit] Job ${jobId} completed inline: ${result.summary}`)
        } catch (handlerErr) {
          const errMsg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr)
          await failJob(jobId, errMsg)
          console.error(`[wizard-submit] Job ${jobId} failed inline:`, errMsg)
          // Still return success — data was saved, cron will retry
        }
      } else {
        console.warn(`[wizard-submit] Job ${jobId} already claimed by worker — skipping inline execution`)
      }
    }

    return NextResponse.json({
      success: true,
      job_id: jobId,
      token: submissionToken,
    })
  } catch (err) {
    console.error('[wizard-submit] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Submit failed' },
      { status: 500 }
    )
  }
}
