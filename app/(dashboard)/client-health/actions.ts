'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { activateService } from '@/lib/operations/activation'
import { repairContactId } from '@/lib/operations/service-delivery'
import { reconcileTier } from '@/lib/operations/portal'

// ─── Retry Stuck Activation ────────────────────────────────

export async function retryActivation(
  offerToken: string
): Promise<{ success: boolean; error?: string }> {
  // P3.3 — delegate to lib/operations/activation.ts so both the manual Retry
  // Activation button and any future MCP tool / CRM button route through the
  // same shared backend per plan §4 P3.3 L625.
  const result = await activateService({ offer_token: offerToken })

  if (result.outcome === 'already_activated') {
    // Preserve prior behavior: already-activated shows as error toast so the
    // button's stale-state render is visibly dismissed on the next refresh.
    return { success: false, error: 'Already activated' }
  }

  if (result.success && result.outcome === 'activated') {
    revalidatePath('/client-health')
    revalidatePath('/leads')
    return { success: true }
  }

  return {
    success: false,
    error: result.error || 'Activation failed',
  }
}

// ─── Repair SD Contact Link ────────────────────────────────

export async function repairSdContactId(
  accountId: string
): Promise<{ success: boolean; fixed?: number; error?: string }> {
  // P3.3 — delegate to lib/operations/service-delivery.repairContactId.
  const result = await repairContactId({ account_id: accountId })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  revalidatePath('/client-health')
  return { success: true, fixed: result.fixed }
}

// ─── Batch Repair All SD Contact Links ────────────────────

export interface BatchRepairResult {
  totalFixed: number
  accountsProcessed: number
  accountsSkipped: number
  errors: Array<{ accountId: string; error: string }>
}

export async function repairAllSdContactIds(): Promise<BatchRepairResult> {
  // 1. Find all accounts with broken active SDs (raw SELECT — not a write,
  // does not trip P2.4 rule 1).
  const { data: brokenAccounts } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id')
    .is('contact_id', null)
    .not('account_id', 'is', null)
    .eq('status', 'active')

  if (!brokenAccounts || brokenAccounts.length === 0) {
    revalidatePath('/client-health')
    return { totalFixed: 0, accountsProcessed: 0, accountsSkipped: 0, errors: [] }
  }

  // Deduplicate account IDs
  const uniqueAccountIds = Array.from(new Set(brokenAccounts.map(sd => sd.account_id as string)))

  // 2. Pre-fetch primary contacts in one query so repairContactId skips its
  // per-account lookup (avoids N+1).
  const { data: allLinks } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id, contact_id')
    .in('account_id', uniqueAccountIds)

  const contactMap = new Map<string, string>()
  for (const link of allLinks ?? []) {
    if (!contactMap.has(link.account_id)) {
      contactMap.set(link.account_id, link.contact_id)
    }
  }

  // 3. Process in batches of 10 via repairContactId.
  let totalFixed = 0
  let accountsProcessed = 0
  let accountsSkipped = 0
  const errors: Array<{ accountId: string; error: string }> = []

  const BATCH_SIZE = 10
  for (let i = 0; i < uniqueAccountIds.length; i += BATCH_SIZE) {
    const batch = uniqueAccountIds.slice(i, i + BATCH_SIZE)

    const results = await Promise.allSettled(
      batch.map(async (accountId) => {
        const contactId = contactMap.get(accountId)
        if (!contactId) {
          accountsSkipped++
          return { accountId, fixed: 0, skipped: true }
        }
        const r = await repairContactId({
          account_id: accountId,
          target_contact_id: contactId,
          active_only: true,
        })
        if (!r.success) {
          throw new Error(r.error || 'repairContactId failed')
        }
        return { accountId, fixed: r.fixed, skipped: false }
      })
    )

    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'fulfilled') {
        totalFixed += r.value.fixed
        if (!r.value.skipped) accountsProcessed++
      } else {
        errors.push({ accountId: batch[j], error: r.reason?.message || 'Unknown error' })
      }
    }
  }

  // 4. Log to action_log (NOT a P2.4-protected table — raw .insert is OK).
  await supabaseAdmin.from('action_log').insert({
    action_type: 'batch_repair',
    table_name: 'service_deliveries',
    record_id: 'batch',
    summary: `Batch SD contact_id repair: ${totalFixed} SDs fixed across ${accountsProcessed} accounts (${accountsSkipped} skipped, ${errors.length} errors)`,
    details: { totalFixed, accountsProcessed, accountsSkipped, errorCount: errors.length },
  })

  revalidatePath('/client-health')
  return { totalFixed, accountsProcessed, accountsSkipped, errors }
}

// ─── Sync Portal Tier (3-way) ──────────────────────────────

export async function syncPortalTier(
  contactId: string
): Promise<{ success: boolean; error?: string; synced?: string }> {
  // P3.3 — delegate to lib/operations/portal.reconcileTier, which is the
  // canonical 3-way reconciler (contacts, accounts, auth.users.app_metadata)
  // using contacts.portal_tier as source of truth. Previous direct-write
  // implementation tripped P2.4 rule 1 on the `.from("accounts").update()`
  // call.
  const result = await reconcileTier({ contact_id: contactId })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  revalidatePath('/client-health')
  return {
    success: true,
    synced: result.resolved_tier ?? undefined,
  }
}
