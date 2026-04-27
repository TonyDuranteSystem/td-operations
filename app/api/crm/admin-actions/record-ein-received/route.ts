import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'
import { normalizeEIN } from '@/lib/jobs/validation'
import { advanceStage, createSD } from '@/lib/operations/service-delivery'
import { updateAccount } from '@/lib/operations/account'
import { syncTier } from '@/lib/operations/sync-tier'
import { enqueueJob } from '@/lib/jobs/queue'
import { APP_BASE_URL } from '@/lib/config'

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
      .select('id, company_name, ein_number, portal_tier, entity_type')
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

    // 3. Advance Company Formation SD directly to "Post-Formation + Banking"
    const advanceResult = await advanceStage({
      delivery_id: formationSD.id,
      target_stage: 'Post-Formation + Banking',
      actor: 'crm-admin',
      notes: `EIN recorded: ${normalizedEIN}`,
    })

    const sdStage = advanceResult.success ? 'Post-Formation + Banking' : (previousStage ?? 'unknown')

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

    // 6. MMLLC: create member info request + send portal message to primary member
    let memberInfoRequestId: string | null = null
    let memberInfoFormUrl: string | null = null

    const isMMLC = account.entity_type === 'Multi Member LLC'
    if (isMMLC) {
      try {
        // Check for existing pending request (idempotent)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existingReq } = await (supabaseAdmin as any)
          .from('member_info_requests')
          .select('id, token, access_code')
          .eq('account_id', account_id)
          .eq('status', 'pending')
          .maybeSingle() as { data: { id: string; token: string; access_code: string } | null }

        let reqToken: string
        let reqCode: string

        if (existingReq) {
          memberInfoRequestId = existingReq.id
          reqToken = existingReq.token
          reqCode = existingReq.access_code
        } else {
          // Get existing members for pre-population
          const { data: existingMembers } = await supabaseAdmin
            .from('members')
            .select('member_type, full_name, company_name, email, phone, ownership_pct, is_primary')
            .eq('account_id', account_id)
            .order('is_primary', { ascending: false })

          const { data: primaryMember } = await supabaseAdmin
            .from('members')
            .select('contact_id')
            .eq('account_id', account_id)
            .eq('is_primary', true)
            .maybeSingle()

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: createdReq } = await (supabaseAdmin as any)
            .from('member_info_requests')
            .insert({
              account_id,
              contact_id: primaryMember?.contact_id || formationSD.contact_id || null,
              status: 'pending',
              company_name: account.company_name,
              entity_type: account.entity_type,
              pre_populated_data: existingMembers?.length
                ? { members: existingMembers.map(m => ({ ...m, ownership_pct: m.ownership_pct ? String(m.ownership_pct) : '' })) }
                : null,
            })
            .select('id, token, access_code')
            .single() as { data: { id: string; token: string; access_code: string } | null }

          if (createdReq) {
            memberInfoRequestId = createdReq.id
            reqToken = createdReq.token
            reqCode = createdReq.access_code
          } else {
            throw new Error('Failed to create member_info_request')
          }
        }

        memberInfoFormUrl = `${APP_BASE_URL}/member-info/${reqToken}/${reqCode}`

        // Send portal message to primary contact
        const primaryContact = formationSD.contact_id
        if (primaryContact) {
          const msgBody = `Great news! The EIN for ${account.company_name} has been issued (${normalizedEIN}).\n\nTo proceed with opening your business bank account, we need the complete information for all LLC members.\n\nPlease fill out this short form:\n${memberInfoFormUrl}\n\nOnce submitted, we will update your account and guide you through the next steps.`
          await supabaseAdmin.from('portal_messages').insert({
            account_id,
            contact_id: primaryContact,
            sender_type: 'admin',
            sender_id: 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631',
            message: msgBody,
          })
        }
      } catch (mmllcErr) {
        console.error('[record-ein-received] MMLLC member info flow failed:', mmllcErr)
        // Non-fatal — EIN recording and tier advance already succeeded
      }
    }

    // 7. Log everything
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
        sd_advance_success: advanceResult.success,
        member_info_request_id: memberInfoRequestId,
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
      member_info_form_url: memberInfoFormUrl,
    })
  } catch (err) {
    console.error('Record EIN received error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
