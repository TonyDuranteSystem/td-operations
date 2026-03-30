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
import { enqueueJob, completeJob, failJob } from '@/lib/jobs/queue'
import type { Job } from '@/lib/jobs/queue'

/** Extract file upload paths from wizard data */
function extractUploadPaths(data: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const val of Object.values(data)) {
    if (typeof val === 'string' && (
      val.includes('/passport_') || val.includes('/articles_') ||
      val.includes('/ein_') || val.includes('/ss4_') ||
      val.includes('/bank_statement') || val.includes('/tax_return')
    )) {
      paths.push(val)
    }
  }
  return paths
}

/** Map wizard_type to submission table name */
function getSubmissionTable(wizardType: string): string | null {
  const map: Record<string, string> = {
    formation: 'formation_submissions',
    onboarding: 'onboarding_submissions',
    tax: 'tax_return_submissions',
    tax_return: 'tax_return_submissions',
  }
  return map[wizardType] || null
}

/** Map wizard_type to job_type for the background handler */
function getJobType(wizardType: string): string | null {
  const map: Record<string, string> = {
    formation: 'formation_setup',
    onboarding: 'onboarding_setup',
    tax: 'tax_form_setup',
    tax_return: 'tax_form_setup',
  }
  return map[wizardType] || null
}

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
        lead_id: null,
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

      // Only include tax_year if we resolved it (avoids NOT NULL constraint violation)
      if (taxYear !== null) submissionRecord.tax_year = taxYear

      const { data: sub, error: subErr } = await supabaseAdmin
        .from(submissionTable)
        .upsert(submissionRecord, { onConflict: 'token' })
        .select('id')
        .single()

      if (subErr) {
        console.error('[wizard-submit] Submission upsert failed:', subErr.message)
      }
      submissionId = sub?.id || null
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
