/**
 * Auto-create portal user for a client.
 *
 * Reusable function called from:
 * - offer_send (MCP tool) → creates portal with 'lead' tier
 * - activate-service (payment confirmed) → auto-creates with 'onboarding' tier
 * - portal_create_user (MCP tool) → manual creation with 'full' tier
 *
 * Idempotent: if user already exists, just updates the tier.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { PORTAL_BASE_URL } from '@/lib/config'
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
  const { accountId, contactId, leadId, tier, skipIfExists: _skipIfExists = true } = params

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
    // User exists — update tier on both contact and account
    const existingContactId = existingUser.app_metadata?.contact_id
    if (existingContactId) {
      await supabaseAdmin
        .from('contacts')
        .update({ portal_tier: tier })
        .eq('id', existingContactId)
    }
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

  // Update contact tier (source of truth)
  if (portalContactId) {
    await supabaseAdmin
      .from('contacts')
      .update({ portal_tier: tier })
      .eq('id', portalContactId)
  }

  // Update account flags (secondary)
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

// ─── Ensure Minimal Account ────────────────────────────

interface EnsureAccountResult {
  accountId: string
  created: boolean
  error?: string
}

/**
 * Ensure a minimal CRM account exists for formation/onboarding clients.
 *
 * Formation clients don't have an account until their form is reviewed.
 * This creates a "Pending Formation - {name}" placeholder so that:
 * - Service deliveries can be linked to an account
 * - Portal sidebar shows correctly
 * - Portal tier can be set on the account
 *
 * Idempotent: if the contact is already linked to an account, returns that.
 */
export async function ensureMinimalAccount(params: {
  contactId: string
  clientName: string
  contractType: string
  offerToken?: string
  leadId?: string
}): Promise<EnsureAccountResult> {
  const { contactId, clientName, contractType, offerToken, leadId } = params

  // Check if contact is already linked to an account
  const { data: existingLink } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contactId)
    .limit(1)
    .maybeSingle()

  if (existingLink?.account_id) {
    // Backfill account_id on contact-only invoices (created at signing, before account existed)
    await supabaseAdmin
      .from("client_invoices")
      .update({ account_id: existingLink.account_id, updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .is("account_id", null)
    await supabaseAdmin
      .from("payments")
      .update({ account_id: existingLink.account_id, updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .is("account_id", null)
    return { accountId: existingLink.account_id, created: false }
  }

  // Also check if lead has an account_id
  if (leadId) {
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('account_id')
      .eq('id', leadId)
      .maybeSingle()
    if (lead?.account_id) {
      // Link contact to existing account
      await supabaseAdmin.from('account_contacts').upsert({
        account_id: lead.account_id,
        contact_id: contactId,
        role: 'Owner',
      }, { onConflict: 'account_id,contact_id' })
      return { accountId: lead.account_id, created: false }
    }
  }

  // Create minimal account
  const statusLabel = contractType === 'formation' ? 'Pending Formation' : 'Pending Onboarding'
  const companyName = `${statusLabel} - ${clientName}`

  const { data: account, error: accErr } = await supabaseAdmin
    .from('accounts')
    .insert({
      company_name: companyName,
      status: 'Pending',
      account_type: 'Client',
      entity_type: contractType === 'formation' ? 'Single Member LLC' : null,
      portal_account: true,
      portal_auto_created: true,
      portal_tier: 'onboarding',
      portal_created_date: new Date().toISOString().split('T')[0],
      notes: `Auto-created on payment. Offer: ${offerToken || 'N/A'}. Will be updated when data form is reviewed.`,
    })
    .select('id')
    .single()

  if (accErr || !account) {
    return { accountId: '', created: false, error: accErr?.message || 'Failed to create account' }
  }

  // Link contact to account
  await supabaseAdmin.from('account_contacts').insert({
    account_id: account.id,
    contact_id: contactId,
    role: 'Owner',
  })

  // Backfill account_id on contact-only invoices (created at signing, before account existed)
  await supabaseAdmin
    .from("client_invoices")
    .update({ account_id: account.id, updated_at: new Date().toISOString() })
    .eq("contact_id", contactId)
    .is("account_id", null)
  await supabaseAdmin
    .from("payments")
    .update({ account_id: account.id, updated_at: new Date().toISOString() })
    .eq("contact_id", contactId)
    .is("account_id", null)

  // Update lead.account_id if lead exists
  if (leadId) {
    await supabaseAdmin
      .from('leads')
      .update({ account_id: account.id })
      .eq('id', leadId)
  }

  return { accountId: account.id, created: true }
}

// ─── Welcome Email ─────────────────────────────────────

/**
 * Send portal welcome email with temporary password.
 * Bilingual: Italian + English.
 * Called after autoCreatePortalUser() when a new user is created.
 */
export async function sendPortalWelcomeEmail(params: {
  email: string
  fullName: string
  tempPassword: string
  language?: string
}): Promise<{ success: boolean; error?: string }> {
  const { email, fullName, tempPassword, language } = params
  const isIt = language === 'it' || language === 'Italian'
  const loginUrl = `${PORTAL_BASE_URL}/portal/login`

  try {
    const { gmailPost } = await import('@/lib/gmail')

    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#18181b;padding:20px;border-radius:12px 12px 0 0">
    <h1 style="color:white;margin:0;font-size:18px">
      ${isIt ? 'Benvenuto nel Portale Tony Durante' : 'Welcome to Tony Durante Portal'}
    </h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    <p>${isIt ? `Ciao ${fullName || ''},` : `Hi ${fullName || 'there'},`}</p>
    <p>${isIt
      ? 'Il tuo account sul portale clienti è stato creato. Ecco le tue credenziali di accesso:'
      : 'Your client portal account has been created. Here are your login credentials:'}</p>
    <div style="background:#f4f4f5;padding:16px;border-radius:8px;margin:16px 0">
      <p style="margin:0 0 8px"><strong>Email:</strong> ${email}</p>
      <p style="margin:0"><strong>${isIt ? 'Password temporanea' : 'Temporary Password'}:</strong> ${tempPassword}</p>
    </div>
    <p>${isIt
      ? 'Al primo accesso ti verrà chiesto di cambiare la password.'
      : 'You will be asked to change your password on first login.'}</p>
    <a href="${loginUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-weight:bold;margin-top:8px">
      ${isIt ? 'Accedi al Portale' : 'Login to Portal'}
    </a>
    ${!isIt ? '' : `
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
    <p style="color:#6b7280;font-size:13px">
      Hi ${fullName || 'there'}, your client portal account has been created.<br>
      <strong>Email:</strong> ${email}<br>
      <strong>Temporary Password:</strong> ${tempPassword}<br>
      You will be asked to change your password on first login.
    </p>
    <a href="${loginUrl}" style="display:inline-block;padding:8px 16px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-size:13px">
      Login to Portal
    </a>`}
  </div>
</div>`

    const subject = isIt
      ? 'Il tuo accesso al Portale Tony Durante'
      : 'Your Tony Durante Portal Account'
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      'From: Tony Durante <support@tonydurante.us>',
      `To: ${email}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html).toString('base64'),
      `--${boundary}--`,
    ].join('\r\n')

    await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[auto-portal] Welcome email failed:', error)
    return { success: false, error }
  }
}

// ─── Portal Tier Upgrade ───────────────────────────────

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

  // Update account tier
  await supabaseAdmin
    .from('accounts')
    .update({ portal_tier: newTier })
    .eq('id', accountId)

  // Also upgrade tier on all linked contacts (source of truth)
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id')
    .eq('account_id', accountId)

  for (const link of links ?? []) {
    await supabaseAdmin
      .from('contacts')
      .update({ portal_tier: newTier })
      .eq('id', link.contact_id)
  }

  return { success: true, previousTier: account.portal_tier }
}
