import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { PORTAL_TIERS, TIER_ORDER, type PortalTier } from '@/lib/portal/tier-config'

// Tiers that are lifecycle markers on accounts, NOT portal access tiers
const LIFECYCLE_TIERS = ['inactive', 'suspended'] as const

export interface SyncTierParams {
  accountId: string
  newTier: PortalTier
  reason: string
  actor?: string
}

export interface ContactTierUpdate {
  contactId: string
  previousTier: string | null
  newTier: PortalTier
}

export interface SyncTierResult {
  success: boolean
  previousTier: string | null
  newTier: PortalTier
  contactsUpdated: ContactTierUpdate[]
  error?: string
}

/**
 * Compute the portal tier for a contact based on their linked accounts.
 * Returns the highest tier across all accounts, excluding lifecycle markers (inactive, suspended, null).
 * If no valid account tiers exist, returns null (caller should preserve the contact's existing tier).
 */
export async function computeContactTier(contactId: string): Promise<PortalTier | null> {
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contactId)

  if (!links || links.length === 0) return null

  const accountIds = links.map(l => l.account_id)
  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('portal_tier')
    .in('id', accountIds)

  if (!accounts || accounts.length === 0) return null

  let highestOrder = -1
  let highestTier: PortalTier | null = null

  for (const acct of accounts) {
    const tier = acct.portal_tier as string | null
    if (!tier) continue
    if ((LIFECYCLE_TIERS as readonly string[]).includes(tier)) continue
    const order = TIER_ORDER[tier as PortalTier]
    if (order !== undefined && order > highestOrder) {
      highestOrder = order
      highestTier = tier as PortalTier
    }
  }

  return highestTier
}

/**
 * Single entry point for all portal tier writes.
 * Writes to accounts, recomputes contact tier for all linked contacts, syncs auth metadata.
 */
export async function syncTier(params: SyncTierParams): Promise<SyncTierResult> {
  const { accountId, newTier, reason, actor = 'system' } = params

  // Validate tier
  if (!PORTAL_TIERS.includes(newTier)) {
    return { success: false, previousTier: null, newTier, contactsUpdated: [], error: `Invalid tier: ${newTier}` }
  }

  // Read current account tier
  const { data: account, error: readErr } = await supabaseAdmin
    .from('accounts')
    .select('portal_tier')
    .eq('id', accountId)
    .single()

  if (readErr || !account) {
    return { success: false, previousTier: null, newTier, contactsUpdated: [], error: `Account not found: ${accountId}` }
  }

  const previousTier = account.portal_tier as string | null

  // Write new tier to account
  const { error: writeErr } = await supabaseAdmin
    .from('accounts')
    .update({ portal_tier: newTier, updated_at: new Date().toISOString() })
    .eq('id', accountId)

  if (writeErr) {
    return { success: false, previousTier, newTier, contactsUpdated: [], error: `Failed to update account: ${writeErr.message}` }
  }

  // Find all contacts linked to this account
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id')
    .eq('account_id', accountId)

  const contactsUpdated: SyncTierResult['contactsUpdated'] = []

  if (links && links.length > 0) {
    // Deduplicate contact IDs
    const contactIds = Array.from(new Set(links.map(l => l.contact_id)))

    for (const contactId of contactIds) {
      // Get current contact tier
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('portal_tier, email')
        .eq('id', contactId)
        .single()

      if (!contact) continue

      const contactPreviousTier = contact.portal_tier as string | null

      // Compute the highest tier across ALL this contact's accounts
      const computedTier = await computeContactTier(contactId)

      // If no valid account tiers (e.g., ITIN-only contact), keep existing tier
      if (computedTier === null) continue

      // Only update if tier actually changed
      if (computedTier !== contactPreviousTier) {
        await supabaseAdmin
          .from('contacts')
          .update({ portal_tier: computedTier, updated_at: new Date().toISOString() })
          .eq('id', contactId)

        contactsUpdated.push({ contactId, previousTier: contactPreviousTier, newTier: computedTier })
      }

      // Sync auth metadata (always, even if tier didn't change — repairs drift)
      if (contact.email) {
        const authUser = await findAuthUserByEmail(contact.email)
        if (authUser && authUser.app_metadata?.portal_tier !== computedTier) {
          await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
            app_metadata: { ...authUser.app_metadata, portal_tier: computedTier },
          })
        }
      }
    }
  }

  // Log to action_log
  await supabaseAdmin.from('action_log').insert({
    actor,
    action_type: 'tier_sync',
    table_name: 'accounts',
    record_id: accountId,
    account_id: accountId,
    summary: `Tier changed from ${previousTier ?? 'null'} to ${newTier} — ${reason}`,
    details: JSON.parse(JSON.stringify({
      old_tier: previousTier,
      new_tier: newTier,
      reason,
      actor,
      contacts_updated: contactsUpdated,
    })),
  })

  return { success: true, previousTier, newTier, contactsUpdated }
}
