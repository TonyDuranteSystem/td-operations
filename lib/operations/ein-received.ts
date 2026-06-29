/**
 * EIN-received workflow trigger — shared core for the formation→active hand-off.
 *
 * Mirrors the side-effects of POST /api/crm/admin-actions/record-ein-received
 * EXCEPT for the MMLLC member-info portal-message flow, which is intentionally
 * excluded here so that silent inline EIN edits don't auto-message clients
 * without UX context. MMLLC clients should still be promoted via the explicit
 * "Record EIN Received" button.
 *
 * Banking Fintech SD is NO LONGER created here (2026-06-20, Antonio): formation
 * finishes at the EIN; banking is self-service (the client applies at a fintech
 * with their EIN + Articles). banking_sd_id stays in the result, always null.
 *
 * Idempotency:
 *   - Formation SD advance: advanceStage no-ops if already past target
 *   - syncTier: no-op if already at active
 *   - welcome_package_prepare job: handler dedupes via welcome_package_status
 *
 * Returns success=false ONLY if no active Company Formation SD is found
 * (the workflow has nothing to do). Per-step failures are recorded in
 * side_effects but do not fail the call.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { advanceStage } from '@/lib/operations/service-delivery'
import { syncTier } from '@/lib/operations/sync-tier'
import { enqueueJob } from '@/lib/jobs/queue'

export interface TriggerEINReceivedParams {
  accountId: string
  einNumber: string
  actor?: string
  reason?: string
}

export interface TriggerEINReceivedResult {
  success: boolean
  side_effects: string[]
  error?: string
  formation_sd_id?: string
  banking_sd_id?: string | null
  welcome_package_job_id?: string | null
}

export async function triggerEINReceivedWorkflow(
  params: TriggerEINReceivedParams,
): Promise<TriggerEINReceivedResult> {
  const { accountId, einNumber, actor = 'system', reason = 'EIN recorded — formation complete' } = params
  const side_effects: string[] = []

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, portal_tier')
    .eq('id', accountId)
    .single()

  if (!account) {
    return { success: false, side_effects, error: `Account not found: ${accountId}` }
  }

  const { data: formationSDs } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, stage, contact_id')
    .eq('account_id', accountId)
    .eq('service_type', 'Company Formation')
    .eq('status', 'active')
    .limit(1)

  if (!formationSDs || formationSDs.length === 0) {
    return { success: false, side_effects, error: 'No active Company Formation service delivery found' }
  }

  const formationSD = formationSDs[0]
  const previousTier = account.portal_tier
  const previousStage = formationSD.stage

  // Banking Fintech SD is intentionally NOT created anymore. Per Antonio
  // (2026-06-20): formation finishes at the EIN. Banking is self-service —
  // the client opens an account with their EIN + Articles of Organization at a
  // fintech of their choice (Relay / Mercury / Sokin / Payset / Wise), surfaced
  // as bank applications in the portal, not tracked as a service delivery. The
  // result still carries banking_sd_id (always null) for backward compatibility.
  const bankingSdId: string | null = null
  side_effects.push('banking_sd_skipped')

  let advanceOk = false
  try {
    const advance = await advanceStage({
      delivery_id: formationSD.id,
      // "EIN Received" = final stage of the 8-stage v2 pipeline (stage 8).
      target_stage: 'EIN Received',
      actor,
      notes: `EIN recorded: ${einNumber}`,
    })
    advanceOk = advance.success
    side_effects.push(advanceOk ? 'formation_sd_advanced' : `formation_sd_advance_skipped:${advance.error ?? 'unknown'}`)
  } catch (e) {
    side_effects.push(`formation_sd_advance_failed:${e instanceof Error ? e.message : 'unknown'}`)
  }

  let tierOk = false
  try {
    const tier = await syncTier({
      accountId,
      newTier: 'active',
      reason,
      actor,
    })
    tierOk = tier.success
    side_effects.push(tierOk ? `tier_synced:${previousTier ?? 'null'}->active` : `tier_sync_failed:${tier.error ?? 'unknown'}`)
  } catch (e) {
    side_effects.push(`tier_sync_failed:${e instanceof Error ? e.message : 'unknown'}`)
  }

  let welcomeJobId: string | null = null
  try {
    const job = await enqueueJob({
      job_type: 'welcome_package_prepare',
      payload: { account_id: accountId },
      priority: 5,
      account_id: accountId,
      created_by: actor,
    })
    welcomeJobId = job.id
    side_effects.push('welcome_package_enqueued')
  } catch (e) {
    side_effects.push(`welcome_package_failed:${e instanceof Error ? e.message : 'unknown'}`)
  }

  await supabaseAdmin.from('action_log').insert({
    actor,
    action_type: 'record_ein_received',
    table_name: 'accounts',
    record_id: accountId,
    account_id: accountId,
    summary: `EIN ${einNumber} workflow triggered for ${account.company_name}. Tier: ${previousTier ?? 'null'} → active. SD: ${previousStage ?? 'unknown'} → EIN Received.`,
    details: {
      ein_number: einNumber,
      formation_sd_id: formationSD.id,
      banking_sd_id: bankingSdId,
      previous_stage: previousStage,
      previous_tier: previousTier,
      welcome_package_job_id: welcomeJobId,
      sd_advance_success: advanceOk,
      tier_sync_success: tierOk,
      side_effects,
      reason,
      source: 'ein-received-helper',
    },
  })

  return {
    success: true,
    side_effects,
    formation_sd_id: formationSD.id,
    banking_sd_id: bankingSdId,
    welcome_package_job_id: welcomeJobId,
  }
}
