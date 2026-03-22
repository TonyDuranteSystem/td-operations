/**
 * Auto-create portal user for a client.
 *
 * Reusable function called from:
 * - offer_send (MCP tool) → creates portal with 'lead' tier
 * - activation flow (payment confirmed) → upgrades to 'onboarding' tier
 * - portal_create_user (MCP tool) → manual creation with 'full' tier
 *
 * Idempotent: if user already exists, just updates the tier.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type { PortalTier } from './tier-config'

interface AutoCreateResult {
  success: boolean
  alreadyExists: boolean
  email?: string
  tempPassword?: string
  userId?: string
  error?: string
}

interface AutoCreateParams {
  accountId?: string
  contactId?: string
  leadId?: string
  tier: PortalTier
  /** If true, skip if portal user already exists (no error) */
  skipIfExists?: boolean
}

export async function autoCreatePortalUser(params: AutoCreateParams): Promise<AutoCreateResult> {
  const { accountId, contactId, leadId, tier, skipIfExists = true } = params

  try {
    // 1. Resolve contact
    let targetContactId = contactId

    if (!targetContactId && accountId) {
      const { data: links } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id')
        .eq('account_id', accountId)
        .limit(1)

      targetContactId = links?.[0]?.contact_id
    }

    if (!targetContactId && leadId) {
      // Get contact from lead's email
      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('email, full_name, language')
        .eq('id', leadId)
        .single()

      if (lead?.email) {
        // Find or create contact from lead
        const { data: existingContact } = await supabaseAdmin
          .from('contacts')
          .select('id')
          .eq('email', lead.email)
          .limit(1)
          .maybeSingle()

        if (existingContact) {
          targetContactId = existingContact.id
        }
        // If no contact exists yet, we can still create a portal user from the lead email
        if (!targetContactId) {
          return await createFromEmail(lead.email, lead.full_name, accountId, tier, lead.language === 'Italian' ? 'it' : 'en')
        }
      }
    }

    if (!targetContactId) {
      return { success: false, alreadyExists: false, error: 'No contact found to create portal user for' }
    }

    // 2. Get contact details
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name, email, language')
      .eq('id', targetContactId)
      .single()

    if (!contact?.email) {
      return { success: false, alreadyExists: false, error: 'Contact has no email address' }
    }

    const contactLang = contact.language === 'Italian' || contact.language === 'it' ? 'it' : 'en'
    return await createFromEmail(contact.email, contact.full_name, accountId, tier, contactLang)
  } catch (err) {
    return {
      success: false,
      alreadyExists: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function createFromEmail(
  email: string,
  fullName: string,
  accountId: string | undefined,
  tier: PortalTier,
  language?: string
): Promise<AutoCreateResult> {
  // Check if user already exists
  const { data: existingList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const existingUser = (existingList?.users ?? []).find(u => u.email === email)

  if (existingUser) {
    // User exists — just update the tier if account exists
    if (accountId) {
      await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: tier })
        .eq('id', accountId)
    }
    return { success: true, alreadyExists: true, email, userId: existingUser.id }
  }

  // Generate temp password
  const tempPassword = `TD${Math.random().toString(36).slice(2, 10)}!`

  // Find or create contact so we can set contact_id in app_metadata
  let portalContactId: string | undefined
  const { data: existingContact } = await supabaseAdmin
    .from('contacts')
    .select('id')
    .eq('email', email)
    .limit(1)
    .maybeSingle()

  if (existingContact) {
    portalContactId = existingContact.id
  } else {
    // Create contact from email + name
    const { data: newContact } = await supabaseAdmin
      .from('contacts')
      .insert({ full_name: fullName, email, language: language === 'it' ? 'Italian' : 'English' })
      .select('id')
      .single()
    portalContactId = newContact?.id
  }

  // Create auth user
  const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    app_metadata: {
      role: 'client',
      ...(portalContactId ? { contact_id: portalContactId } : {}),
    },
    user_metadata: {
      full_name: fullName,
      must_change_password: true,
      ...(language ? { language } : {}),
    },
  })

  if (createError) {
    return { success: false, alreadyExists: false, error: createError.message }
  }

  // Update account flags
  if (accountId) {
    await supabaseAdmin
      .from('accounts')
      .update({
        portal_account: true,
        portal_tier: tier,
        portal_auto_created: true,
        portal_created_date: new Date().toISOString().split('T')[0],
      })
      .eq('id', accountId)
  }

  return {
    success: true,
    alreadyExists: false,
    email,
    tempPassword,
    userId: newUser.user.id,
  }
}

/**
 * Upgrade a portal user's tier.
 * Called when: payment confirmed, data reviewed, service completed.
 */
export async function upgradePortalTier(
  accountId: string,
  newTier: PortalTier
): Promise<{ success: boolean; previousTier?: string; error?: string }> {
  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('portal_tier')
    .eq('id', accountId)
    .single()

  if (error || !account) {
    return { success: false, error: error?.message || 'Account not found' }
  }

  const tierOrder: PortalTier[] = ['lead', 'onboarding', 'active', 'full']
  const currentIdx = tierOrder.indexOf((account.portal_tier || 'active') as PortalTier)
  const newIdx = tierOrder.indexOf(newTier)

  // Only upgrade, never downgrade
  if (newIdx <= currentIdx) {
    return { success: true, previousTier: account.portal_tier }
  }

  await supabaseAdmin
    .from('accounts')
    .update({ portal_tier: newTier })
    .eq('id', accountId)

  return { success: true, previousTier: account.portal_tier }
}
