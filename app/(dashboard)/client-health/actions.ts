'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { INTERNAL_BASE_URL } from '@/lib/config'

// ─── Retry Stuck Activation ────────────────────────────────

export async function retryActivation(
  offerToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Verify the activation exists and is stuck
    const { data: pa } = await supabaseAdmin
      .from('pending_activations')
      .select('id, status, activated_at, offer_token')
      .eq('offer_token', offerToken)
      .single()

    if (!pa) {
      return { success: false, error: 'Activation not found' }
    }

    if (pa.activated_at) {
      return { success: false, error: 'Already activated' }
    }

    if (pa.status !== 'payment_confirmed') {
      return { success: false, error: `Status is "${pa.status}" — must be payment_confirmed` }
    }

    // Call the activate-service endpoint
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL || INTERNAL_BASE_URL}/api/workflows/activate-service`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ pending_activation_id: pa.id }),
      }
    )

    const data = await res.json()

    if (!res.ok) {
      return { success: false, error: data.error || `Activation failed (${res.status})` }
    }

    revalidatePath('/client-health')
    revalidatePath('/leads')
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Repair SD Contact Link ────────────────────────────────

export async function repairSdContactId(
  accountId: string
): Promise<{ success: boolean; fixed?: number; error?: string }> {
  try {
    // Get the primary contact for this account
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', accountId)
      .limit(1)

    if (!links || links.length === 0) {
      return { success: false, error: 'No contact linked to this account' }
    }

    const primaryContactId = links[0].contact_id

    // Find SDs with missing or wrong contact_id
    const { data: brokenSDs } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, contact_id')
      .eq('account_id', accountId)
      .or(`contact_id.is.null,contact_id.neq.${primaryContactId}`)

    if (!brokenSDs || brokenSDs.length === 0) {
      return { success: true, fixed: 0 }
    }

    // Fix them
    const { error } = await supabaseAdmin
      .from('service_deliveries')
      .update({ contact_id: primaryContactId, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .or(`contact_id.is.null,contact_id.neq.${primaryContactId}`)

    if (error) {
      return { success: false, error: error.message }
    }

    revalidatePath('/client-health')
    return { success: true, fixed: brokenSDs.length }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Batch Repair All SD Contact Links ────────────────────

export interface BatchRepairResult {
  totalFixed: number
  accountsProcessed: number
  accountsSkipped: number
  errors: Array<{ accountId: string; error: string }>
}

export async function repairAllSdContactIds(): Promise<BatchRepairResult> {
  // 1. Find all accounts with broken SDs
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

  // 2. Fetch primary contacts for all accounts in one query
  const { data: allLinks } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id, contact_id')
    .in('account_id', uniqueAccountIds)

  const contactMap = new Map<string, string>()
  for (const link of allLinks ?? []) {
    // First contact per account wins (same as per-account repair)
    if (!contactMap.has(link.account_id)) {
      contactMap.set(link.account_id, link.contact_id)
    }
  }

  // 3. Process in batches of 10
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
          return 0
        }

        const { data: broken } = await supabaseAdmin
          .from('service_deliveries')
          .select('id')
          .eq('account_id', accountId)
          .is('contact_id', null)
          .eq('status', 'active')

        if (!broken || broken.length === 0) return 0

        const { error } = await supabaseAdmin
          .from('service_deliveries')
          .update({ contact_id: contactId, updated_at: new Date().toISOString() })
          .eq('account_id', accountId)
          .is('contact_id', null)
          .eq('status', 'active')

        if (error) throw new Error(error.message)
        return broken.length
      })
    )

    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'fulfilled') {
        totalFixed += r.value
        if (contactMap.has(batch[j])) accountsProcessed++
      } else {
        errors.push({ accountId: batch[j], error: r.reason?.message || 'Unknown error' })
      }
    }
  }

  // 4. Log to action_log
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
  try {
    // Get contact's portal_tier (source of truth)
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('id, portal_tier, email')
      .eq('id', contactId)
      .single()

    if (!contact) {
      return { success: false, error: 'Contact not found' }
    }

    const tier = contact.portal_tier || 'lead'

    // Sync to accounts
    const { data: accountLinks } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contactId)

    if (accountLinks) {
      for (const link of accountLinks) {
        await supabaseAdmin
          .from('accounts')
          .update({ portal_tier: tier })
          .eq('id', link.account_id)
      }
    }

    // Sync to auth.users metadata
    if (contact.email) {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const authUser = users?.find(u => u.email?.toLowerCase() === contact.email?.toLowerCase())

      if (authUser) {
        const currentTier = authUser.app_metadata?.portal_tier
        if (currentTier !== tier) {
          await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
            app_metadata: { ...authUser.app_metadata, portal_tier: tier },
          })
        }
      }
    }

    revalidatePath('/client-health')
    return { success: true, synced: tier }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
