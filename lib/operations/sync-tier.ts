import { supabaseAdmin } from '@/lib/supabase-admin'
import { listAllAuthUsers } from '@/lib/auth-admin-helpers'
import type { User } from '@supabase/supabase-js'
import { PORTAL_TIERS, TIER_ORDER, type PortalTier } from '@/lib/portal/tier-config'

// Tiers that are lifecycle markers on accounts, NOT portal access tiers
const LIFECYCLE_TIERS = ['inactive', 'suspended'] as const

export interface SyncTierParams {
  accountId: string
  newTier: PortalTier
  reason: string
  actor?: string
  /**
   * Allow downgrading to a lower tier (e.g. lead < formation < onboarding < active).
   * Defaults to false — most callers should never downgrade an existing client.
   * Set true only for intentional demotions (account closure, service cancellation, admin override).
   */
  allowDowngrade?: boolean
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
 * PURE: the client login of a contact out of an already-read list of logins. Only CLIENT logins count (staff and admin
 * logins are never touched by a tier sync). Tied to the contact first, then by the contact's email. When several fit
 * (e.g. after a failed delete) the most recently signed-in one wins, ties broken by id, so the choice never flips between runs.
 */
export function pickLoginForContact(users: User[], contactId: string, email: string | null): User | null {
  const clients = users.filter((u) => (u.app_metadata as { role?: string } | undefined)?.role === 'client')
  const rank = (list: User[]): User | null => {
    if (list.length === 0) return null
    return [...list].sort((a, b) => {
      const ta = a.last_sign_in_at ? Date.parse(a.last_sign_in_at) : 0
      const tb = b.last_sign_in_at ? Date.parse(b.last_sign_in_at) : 0
      return tb - ta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })[0]
  }
  const byContact = rank(clients.filter((u) => (u.app_metadata as { contact_id?: string } | undefined)?.contact_id === contactId))
  if (byContact) return byContact
  const want = (email ?? '').toLowerCase().trim()
  return want ? rank(clients.filter((u) => (u.email ?? '').toLowerCase().trim() === want)) : null
}

/**
 * The client login of a contact, from ONE scan of the logins. Found by the contact it is tied to first (a login moved by a
 * contact merge keeps the removed contact's email, which the merge folds into the kept contact's alternate emails, so the
 * email alone no longer finds it), then by the contact's email.
 */
export async function findLoginForContact(contactId: string, email: string | null, users?: User[]): Promise<User | null> {
  return pickLoginForContact(users ?? await listAllAuthUsers(), contactId, email)
}

/** Reads the logins at most once per run (a tier sync loops over contacts; one scan serves them all). */
function lazyLogins(): () => Promise<User[]> {
  let all: Promise<User[]> | null = null
  return () => (all ??= listAllAuthUsers())
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
    .is('access_revoked_at', null)
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
 * Recompute and sync portal_tier for every contact linked to `accountId`.
 *
 * Use this when an account's tier was just written by the caller and you need
 * the linked contacts + auth metadata to catch up — including when the new
 * account tier is a lifecycle marker (`inactive`, `suspended`) that `syncTier`
 * itself refuses. Each contact's new tier is the MAX of its remaining
 * non-lifecycle account tiers via `computeContactTier`; if that returns null
 * the contact's existing tier is preserved (same contract as `syncTier`).
 *
 * Does NOT write to the accounts table — the caller owns that.
 */
export async function syncContactTiersForAccount(
  accountId: string,
  actor = 'system',
): Promise<ContactTierUpdate[]> {
  const { data: links } = await supabaseAdmin
    // portal-access-ok: tier follows the company; a no-access member simply keeps their other tier
    .from('account_contacts')
    .select('contact_id')
    .eq('account_id', accountId)

  if (!links || links.length === 0) return []

  const contactIds = Array.from(new Set(links.map(l => l.contact_id)))
  const contactsUpdated: ContactTierUpdate[] = []
  const logins = lazyLogins()

  for (const contactId of contactIds) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('portal_tier, email')
      .eq('id', contactId)
      .single()

    if (!contact) continue

    const contactPreviousTier = contact.portal_tier as string | null
    const computedTier = await computeContactTier(contactId)
    if (computedTier === null) continue

    if (computedTier !== contactPreviousTier) {
      await supabaseAdmin
        .from('contacts')
        .update({ portal_tier: computedTier, updated_at: new Date().toISOString() })
        .eq('id', contactId)
      contactsUpdated.push({ contactId, previousTier: contactPreviousTier, newTier: computedTier })
    }

    {
      const authUser = await findLoginForContact(contactId, contact.email, await logins())
      if (authUser && authUser.app_metadata?.portal_tier !== computedTier) {
        await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          app_metadata: { ...authUser.app_metadata, portal_tier: computedTier },
        })
      }
    }
  }

  if (contactsUpdated.length > 0) {
    await supabaseAdmin.from('action_log').insert({
      actor,
      action_type: 'tier_sync',
      table_name: 'contacts',
      record_id: accountId,
      account_id: accountId,
      summary: `Contact tier recompute after account change — ${contactsUpdated.length} contact(s) updated`,
      details: JSON.parse(JSON.stringify({ accountId, contacts_updated: contactsUpdated })),
    })
  }

  return contactsUpdated
}

/**
 * Single entry point for all portal tier writes.
 * Writes to accounts, recomputes contact tier for all linked contacts, syncs auth metadata.
 */
export async function syncTier(params: SyncTierParams): Promise<SyncTierResult> {
  const { accountId, newTier, reason, actor = 'system', allowDowngrade = false } = params

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

  // Downgrade guard: refuse to lower a client's tier unless explicitly allowed.
  // This prevents offer-publish (tier:'lead') from overwriting active/onboarding/formation clients.
  if (!allowDowngrade && previousTier && previousTier in TIER_ORDER) {
    const prevOrder = TIER_ORDER[previousTier as PortalTier]
    const newOrder = TIER_ORDER[newTier]
    if (newOrder < prevOrder) {
      // Silent no-op — return success so callers don't blow up, but don't touch the DB
      return { success: true, previousTier, newTier: previousTier as PortalTier, contactsUpdated: [] }
    }
  }

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
    // portal-access-ok: tier follows the company; a no-access member simply keeps their other tier
    .from('account_contacts')
    .select('contact_id')
    .eq('account_id', accountId)

  const contactsUpdated: SyncTierResult['contactsUpdated'] = []

  if (links && links.length > 0) {
    // Deduplicate contact IDs
    const contactIds = Array.from(new Set(links.map(l => l.contact_id)))
    const logins = lazyLogins()

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
      {
        const authUser = await findLoginForContact(contactId, contact.email, await logins())
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
