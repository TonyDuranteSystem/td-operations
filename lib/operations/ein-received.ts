/**
 * EIN-received workflow trigger — shared core for the formation→active hand-off.
 *
 * FLEXIBLE FORMATION MODEL (Antonio 2026-05-28): formation ENDS at EIN received.
 * The EIN is the terminal event — the company becomes ACTIVE and the Company
 * Formation SD is marked COMPLETE IN PLACE. Everything that used to be auto-
 * triggered here is now DECOUPLED:
 *   - Banking: NO auto-create. The client self-applies in the portal.
 *   - Lease / Operating Agreement: NOT auto-created. OA is client self-service
 *     (/portal/documents/generate); the lease is a separate staff action.
 *   - Welcome / review emails: DROPPED (activation is reflected in the portal).
 * The MMLLC member-info portal-message flow is intentionally excluded here so
 * that silent inline EIN edits don't auto-message clients without UX context —
 * it still runs through the explicit "Record EIN Received" button.
 *
 * Idempotency:
 *   - Formation SD: markServiceComplete no-ops if already completed
 *   - syncTier: no-op if already at active
 *
 * Returns success=false ONLY if no active Company Formation SD is found
 * (the workflow has nothing to do). Per-step failures are recorded in
 * side_effects but do not fail the call.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { markServiceComplete } from '@/lib/operations/service-delivery'
import { syncTier } from '@/lib/operations/sync-tier'

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

  // Formation ENDS at EIN: complete the Company Formation SD IN PLACE (no stage
  // advance → no banking/lease/welcome side-effects). Decoupled per the
  // Flexible Formation model — banking is portal self-service, lease/OA are
  // separate, welcome/review emails are dropped.
  let completeOk = false
  try {
    const done = await markServiceComplete({
      delivery_id: formationSD.id,
      actor,
      reason: `EIN received: ${einNumber} — formation complete`,
    })
    completeOk = done.success
    side_effects.push(completeOk ? `formation_sd_${done.outcome}` : `formation_sd_complete_failed:${done.error ?? 'unknown'}`)
  } catch (e) {
    side_effects.push(`formation_sd_complete_failed:${e instanceof Error ? e.message : 'unknown'}`)
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

  await supabaseAdmin.from('action_log').insert({
    actor,
    action_type: 'record_ein_received',
    table_name: 'accounts',
    record_id: accountId,
    account_id: accountId,
    summary: `EIN ${einNumber} workflow triggered for ${account.company_name}. Tier: ${previousTier ?? 'null'} → active. Formation SD completed (was: ${previousStage ?? 'unknown'}).`,
    details: {
      ein_number: einNumber,
      formation_sd_id: formationSD.id,
      previous_stage: previousStage,
      previous_tier: previousTier,
      formation_complete_success: completeOk,
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
  }
}
