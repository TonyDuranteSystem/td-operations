import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { normalizeEIN } from '@/lib/jobs/validation'
import { advanceStage, createSD } from '@/lib/operations/service-delivery'
import { updateAccount } from '@/lib/operations/account'
import { syncTier } from '@/lib/operations/sync-tier'
import { enqueueJob } from '@/lib/jobs/queue'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'record_ein_received')) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await req.json()
    const { account_id, ein_number, drive_file_id } = body

    if (!account_id || !ein_number) {
      return NextResponse.json({ error: 'account_id and ein_number are required' }, { status: 400 })
    }

    // Validate EIN format — normalizeEIN returns canonical XX-XXXXXXX or null
    const normalizedEIN = normalizeEIN(ein_number)
    if (!normalizedEIN) {
      return NextResponse.json(
        { error: `Invalid EIN format: "${ein_number}". Expected 9 digits (e.g., 30-1482516 or 301482516).` },
        { status: 400 },
      )
    }

    // Validate account exists
    const { data: account, error: accErr } = await supabaseAdmin
      .from('accounts')
      .select('id, company_name, ein_number, portal_tier')
      .eq('id', account_id)
      .single()

    if (accErr || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    // Find active Company Formation SD
    const { data: formationSDs, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, stage, status, contact_id')
      .eq('account_id', account_id)
      .eq('service_type', 'Company Formation')
      .eq('status', 'active')
      .limit(1)

    if (sdErr) {
      return NextResponse.json(
        { error: `Failed to query service deliveries: ${sdErr.message}` },
        { status: 500 },
      )
    }

    if (!formationSDs || formationSDs.length === 0) {
      return NextResponse.json(
        { error: 'No active Company Formation service delivery found for this account' },
        { status: 400 },
      )
    }

    const formationSD = formationSDs[0]
    const previousTier = account.portal_tier
    const previousStage = formationSD.stage

    // 2. Write EIN to account via operations layer
    const einWriteResult = await updateAccount({
      id: account_id,
      patch: { ein_number: normalizedEIN },
      actor: 'crm-admin',
      summary: `EIN recorded: ${normalizedEIN}`,
    })

    if (!einWriteResult.success) {
      return NextResponse.json({ error: `Failed to save EIN: ${einWriteResult.error}` }, { status: 500 })
    }

    // 2b. Create Banking Fintech SD (deferred from payment per SOP v7.2 Phase 0)
    // Guard: skip if one already exists (idempotent — old clients may have it from before the formation SD filter fix)
    let bankingSdId: string | null = null
    const { data: existingBankingSd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id')
      .eq('account_id', account_id)
      .eq('service_type', 'Banking Fintech')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    if (!existingBankingSd) {
      try {
        const bankingSd = await createSD({
          service_type: 'Banking Fintech',
          service_name: `Banking Fintech - ${account.company_name}`,
          account_id,
          contact_id: formationSD.contact_id || null,
          notes: `Auto-created on EIN received for ${account.company_name} (${normalizedEIN})`,
        })
        bankingSdId = bankingSd.id
      } catch (e) {
        console.error('[record-ein-received] Banking Fintech SD creation failed:', e)
        // Non-fatal — EIN recording continues
      }
    } else {
      bankingSdId = existingBankingSd.id
    }

    // 3. Advance Company Formation SD: current → "EIN Received" → "Post-Formation + Banking"
    const einReceivedResult = await advanceStage({
      delivery_id: formationSD.id,
      target_stage: 'EIN Received',
      actor: 'crm-admin',
      notes: `EIN recorded: ${normalizedEIN}`,
    })

    let sdStage = einReceivedResult.success ? 'EIN Received' : (previousStage ?? 'unknown')

    if (einReceivedResult.success) {
      const postFormationResult = await advanceStage({
        delivery_id: formationSD.id,
        target_stage: 'Post-Formation + Banking',
        actor: 'crm-admin',
        notes: 'Auto-advanced after EIN received',
      })
      if (postFormationResult.success) {
        sdStage = 'Post-Formation + Banking'
      }
    }

    // 4. Enqueue welcome package job explicitly (handler deduplicates via welcome_package_status)
    const welcomeJob = await enqueueJob({
      job_type: 'welcome_package_prepare',
      payload: { account_id },
      priority: 5,
      account_id,
      created_by: 'crm-record-ein',
    })

    // 5. Sync tier to active
    const tierResult = await syncTier({
      accountId: account_id,
      newTier: 'active',
      reason: 'EIN received — formation complete',
      actor: 'crm-admin',
    })

    // 6. Log everything
    await supabaseAdmin.from('action_log').insert({
      action_type: 'record_ein_received',
      table_name: 'accounts',
      record_id: account_id,
      account_id,
      summary: `EIN ${normalizedEIN} recorded for ${account.company_name}. Tier: ${previousTier ?? 'null'} → active. SD advanced to ${sdStage}.`,
      details: {
        ein_number: normalizedEIN,
        drive_file_id: drive_file_id || null,
        formation_sd_id: formationSD.id,
        banking_sd_id: bankingSdId,
        previous_stage: previousStage,
        new_stage: sdStage,
        previous_tier: previousTier,
        welcome_package_job_id: welcomeJob.id,
        sd_advance_ein_received: einReceivedResult.success,
        source: 'crm-button',
      },
    })

    return NextResponse.json({
      success: true,
      ein_number: normalizedEIN,
      tier_result: {
        previousTier: tierResult.previousTier,
        newTier: tierResult.newTier,
        success: tierResult.success,
      },
      sd_stage: sdStage,
      banking_sd_id: bankingSdId,
      welcome_package_job_id: welcomeJob.id,
    })
  } catch (err) {
    console.error('Record EIN received error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
