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
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { PORTAL_BASE_URL } from '@/lib/config'
import type { PortalTier } from './tier-config'
import { getEntityTypeFromContract } from './entity-type-from-contract'

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
  /** If true (default), marks account as auto-created. Set false for manual CRM actions. */
  autoCreated?: boolean
  /** Override email — use this instead of resolving from lead/account/contact. Used by offer publish to ensure portal user matches offer.client_email exactly. */
  emailOverride?: string
  /** Override full name — paired with emailOverride. */
  nameOverride?: string
}

export async function autoCreatePortalUser(params: AutoCreateParams): Promise<AutoCreateResult> {
  const { accountId, contactId, leadId, tier, skipIfExists: _skipIfExists = true, autoCreated = true, emailOverride, nameOverride } = params

  try {
    // 0. If emailOverride provided, skip all resolution and use it directly
    if (emailOverride) {
      return await createFromEmail(emailOverride, nameOverride || emailOverride.split('@')[0], accountId, tier, undefined, autoCreated, undefined)
    }

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
          return await createFromEmail(lead.email, lead.full_name, accountId, tier, lead.language === 'Italian' ? 'it' : 'en', autoCreated, undefined)
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
    return await createFromEmail(contact.email, contact.full_name, accountId, tier, contactLang, autoCreated, targetContactId)
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
  language?: string,
  autoCreated = true,
  /** Caller-resolved contact_id — used to backfill auth metadata if missing */
  callerContactId?: string,
): Promise<AutoCreateResult> {
  // Check if user already exists — paginated via findAuthUserByEmail
  // (P1.9: replaces the listUsers({ perPage: 1000 }).find pattern that
  // silently breaks once auth.users > 1000 rows).
  const existingUser = await findAuthUserByEmail(email)

  if (existingUser) {
    // User exists — resolve contact_id (prefer auth metadata, backfill from caller or DB)
    let resolvedContactId = existingUser.app_metadata?.contact_id || callerContactId

    // Verify the contact still exists (may have been deleted during offer recreate)
    if (resolvedContactId) {
      const { data: contactExists } = await supabaseAdmin
        .from('contacts')
        .select('id')
        .eq('id', resolvedContactId)
        .maybeSingle()
      if (!contactExists) resolvedContactId = undefined
    }

    if (!resolvedContactId) {
      // Look up contact by email
      const { data: contactByEmail } = await supabaseAdmin
        .from('contacts')
        .select('id')
        .eq('email', email)
        .limit(1)
        .maybeSingle()
      resolvedContactId = contactByEmail?.id
    }

    // If still no contact, create one (same as new-user path)
    // This guarantees contact_id is always set before returning success
    if (!resolvedContactId) {
      // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; extract to lib/operations/ per dev_task 7ebb1e0c
      const { data: createdContact } = await supabaseAdmin
        .from('contacts')
        .insert({ full_name: fullName, email, language: language === 'it' ? 'Italian' : 'English' })
        .select('id')
        .single()
      resolvedContactId = createdContact?.id
    }

    // Update contact tier
    if (resolvedContactId) {
      // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.update; extract to reconcileTier() in lib/operations/portal.ts per dev_task 7ebb1e0c
      await supabaseAdmin
        .from('contacts')
        // eslint-disable-next-line no-restricted-syntax -- Phase D1 contacts.portal_tier write; routes through reconcileTier() per dev_task 7ebb1e0c
        .update({ portal_tier: tier })
        .eq('id', resolvedContactId)
    }
    if (accountId) {
      // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update portal_tier; extract to reconcileTier() per dev_task 7ebb1e0c
      await supabaseAdmin
        .from('accounts')
        .update({ portal_tier: tier })
        .eq('id', accountId)
    }
    // Sync portal_tier + backfill contact_id to auth metadata
    await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
      app_metadata: {
        ...existingUser.app_metadata,
        portal_tier: tier,
        ...(resolvedContactId ? { contact_id: resolvedContactId } : {}),
      },
    })
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
    // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; extract to lib/operations/ per dev_task 7ebb1e0c
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
    // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.update; extract to reconcileTier() in lib/operations/portal.ts per dev_task 7ebb1e0c
    await supabaseAdmin
      .from('contacts')
      // eslint-disable-next-line no-restricted-syntax -- Phase D1 contacts.portal_tier write; routes through reconcileTier() per dev_task 7ebb1e0c
      .update({ portal_tier: tier })
      .eq('id', portalContactId)
  }

  // Update account flags (secondary)
  if (accountId) {
    // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update; extract to lib/operations/portal.ts per dev_task 7ebb1e0c
    await supabaseAdmin
      .from('accounts')
      .update({
        portal_account: true,
        portal_tier: tier,
        portal_auto_created: autoCreated,
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
 * Ensure a minimal CRM account exists for formation/onboarding clients,
 * or for standalone business-context services (tax return, EIN, banking, closure, etc.).
 *
 * Formation clients don't have an account until their form is reviewed.
 * This creates a placeholder so that:
 * - Service deliveries can be linked to an account
 * - Portal sidebar shows correctly
 * - Portal tier can be set on the account
 *
 * When isStandaloneBusiness=true (non-formation, non-onboarding business service):
 * - account_type is set to 'One-Time' instead of 'Client'
 * - placeholder name is "Pending Company — {name}" instead of "Pending Formation/Onboarding"
 *
 * Idempotent: if the contact is already linked to an account, returns that.
 */
export async function ensureMinimalAccount(params: {
  contactId: string
  clientName: string
  contractType: string
  offerToken?: string
  leadId?: string
  isStandaloneBusiness?: boolean
}): Promise<EnsureAccountResult> {
  const { contactId, clientName, contractType, offerToken, leadId, isStandaloneBusiness } = params

  // Phase 0 safety: read the entity type the client picked on the signed contract.
  // Used for new-account INSERT below, and for reconciliation on the existing-account branches.
  const entityTypeLookup = await getEntityTypeFromContract(offerToken)

  // Helper to log entity_type reconciliation mismatches to the audit trail.
  // Non-fatal: we flag the discrepancy for the post-build case review rather than blocking activation.
  const logEntityTypeMismatch = async (
    accountId: string,
    existingEntityType: string,
  ): Promise<void> => {
    await supabaseAdmin.from('action_log').insert({
      actor: 'system:ensureMinimalAccount',
      action_type: 'entity_type_mismatch',
      table_name: 'accounts',
      record_id: accountId,
      account_id: accountId,
      contact_id: contactId,
      summary: `Contract declares ${entityTypeLookup.accountLabel} but existing account is ${existingEntityType}. Flagged for case review.`,
      details: {
        offer_token: offerToken || null,
        contract_llc_type: entityTypeLookup.rawLlcType,
        existing_entity_type: existingEntityType,
        source: entityTypeLookup.source,
      },
    })
  }

  // Check if contact is already linked to an account
  const { data: existingLink } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contactId)
    .limit(1)
    .maybeSingle()

  if (existingLink?.account_id) {
    // Reconciliation: if the signed contract declares a different entity type than the existing account, surface it.
    if (entityTypeLookup.accountLabel) {
      const { data: existingAccount } = await supabaseAdmin
        .from('accounts')
        .select('entity_type')
        .eq('id', existingLink.account_id)
        .maybeSingle()
      if (existingAccount?.entity_type && existingAccount.entity_type !== entityTypeLookup.accountLabel) {
        await logEntityTypeMismatch(existingLink.account_id, existingAccount.entity_type)
      }
    }
    // Backfill account_id on contact-only invoices (created at signing, before account existed)
    await supabaseAdmin
      .from("client_invoices")
      .update({ account_id: existingLink.account_id, updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .is("account_id", null)
    // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw payments.update; extract to lib/operations/payment.ts per dev_task 7ebb1e0c
    await supabaseAdmin
      .from("payments")
      .update({ account_id: existingLink.account_id, updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .is("account_id", null)
    return { accountId: existingLink.account_id, created: false }
  }

  // Also check if lead has a converted_to_account_id
  if (leadId) {
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('converted_to_account_id')
      .eq('id', leadId)
      .maybeSingle()
    if (lead?.converted_to_account_id) {
      // Reconciliation on this branch too
      if (entityTypeLookup.accountLabel) {
        const { data: existingAccount } = await supabaseAdmin
          .from('accounts')
          .select('entity_type')
          .eq('id', lead.converted_to_account_id)
          .maybeSingle()
        if (existingAccount?.entity_type && existingAccount.entity_type !== entityTypeLookup.accountLabel) {
          await logEntityTypeMismatch(lead.converted_to_account_id, existingAccount.entity_type)
        }
      }
      // Link contact to existing account
      await supabaseAdmin.from('account_contacts').upsert({
        account_id: lead.converted_to_account_id,
        contact_id: contactId,
        role: 'Owner',
      }, { onConflict: 'account_id,contact_id' })
      return { accountId: lead.converted_to_account_id, created: false }
    }
  }

  // Create minimal account
  const statusLabel = isStandaloneBusiness
    ? 'Pending Company'
    : contractType === 'formation' ? 'Pending Formation' : 'Pending Onboarding'
  const separator = isStandaloneBusiness ? ' — ' : ' - '
  const companyName = `${statusLabel}${separator}${clientName}`

  // Phase 0 safety: prefer the signed contract's declared entity_type for formation;
  // fall back to legacy default (Single Member LLC) only when no contract is available,
  // to keep legacy/unusual call sites working. Non-formation stays null (wizard fills it in later).
  const entityTypeForInsert = entityTypeLookup.accountLabel
    ?? (contractType === 'formation' ? ('Single Member LLC' as const) : null)

  // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.insert; extract to lib/operations/account.ts per dev_task 7ebb1e0c
  const { data: account, error: accErr } = await supabaseAdmin
    .from('accounts')
    .insert({
      company_name: companyName,
      status: contractType === 'formation' ? 'Pending Formation' : 'Active',
      account_type: isStandaloneBusiness ? 'One-Time' : 'Client',
      entity_type: entityTypeForInsert,
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

  // Phase 0 diagnostic: log when a formation account was created without a matching signed contract.
  // This means we fell back to the legacy default (Single Member LLC) — surface it for case review.
  if (contractType === 'formation' && !entityTypeLookup.accountLabel) {
    await supabaseAdmin.from('action_log').insert({
      actor: 'system:ensureMinimalAccount',
      action_type: 'entity_type_fallback',
      table_name: 'accounts',
      record_id: account.id,
      account_id: account.id,
      contact_id: contactId,
      summary: `Formation account created without signed contract — entity_type defaulted to Single Member LLC.`,
      details: {
        offer_token: offerToken || null,
        source: entityTypeLookup.source,
        raw_llc_type: entityTypeLookup.rawLlcType,
      },
    })
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
  // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw payments.update; extract to lib/operations/payment.ts per dev_task 7ebb1e0c
  await supabaseAdmin
    .from("payments")
    .update({ account_id: account.id, updated_at: new Date().toISOString() })
    .eq("contact_id", contactId)
    .is("account_id", null)

  // Update lead.converted_to_account_id if lead exists
  if (leadId) {
    await supabaseAdmin
      .from('leads')
      .update({ converted_to_account_id: account.id })
      .eq('id', leadId)
  }

  return { accountId: account.id, created: true }
}

// ─── Welcome Email ─────────────────────────────────────

/**
 * Send portal welcome email with temporary password.
 * Single-language: Italian OR English based on client preference (never mixed).
 * Includes full portal feature overview, PWA install instructions, and chat value proposition.
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
    const html = buildWelcomeHtml({ email, fullName, tempPassword, loginUrl, isIt })

    const subject = isIt
      ? 'Il tuo nuovo Portale Clienti \u2014 Tony Durante LLC'
      : 'Your New Client Portal \u2014 Tony Durante LLC'
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

function buildWelcomeHtml(p: {
  email: string; fullName: string; tempPassword: string; loginUrl: string; isIt: boolean
}): string {
  const { email, fullName, tempPassword, loginUrl, isIt } = p
  const name = fullName || (isIt ? '' : 'there')

  // Reusable row builder
  const row = (icon: string, label: string, desc: string) =>
    `<tr><td style="padding:6px 0;font-size:14px;color:#3f3f46;vertical-align:top;width:24px">${icon}</td><td style="padding:6px 0;font-size:14px;color:#3f3f46"><strong>${label}</strong> \u2014 ${desc}</td></tr>`
  const smallRow = (icon: string, label: string, desc: string) =>
    `<tr><td style="padding:5px 0;font-size:13px;color:#3f3f46;vertical-align:top;width:24px">${icon}</td><td style="padding:5px 0;font-size:13px;color:#3f3f46"><strong>${label}</strong> \u2014 ${desc}</td></tr>`

  if (isIt) {
    return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
<div style="background:#18181b;padding:24px 28px;border-radius:12px 12px 0 0">
  <h1 style="color:white;margin:0;font-size:20px">Tony Durante LLC</h1>
  <p style="color:#a1a1aa;margin:6px 0 0;font-size:14px">Il tuo nuovo Portale Clienti</p>
</div>
<div style="background:white;border:1px solid #e5e7eb;border-top:none;padding:28px;border-radius:0 0 12px 12px">
  <p style="font-size:15px;color:#18181b">Ciao ${name},</p>
  <p style="font-size:15px;color:#3f3f46;line-height:1.6">Abbiamo creato una piattaforma professionale e sicura dedicata alla gestione della tua LLC. Non dovrai pi\u00f9 cercare documenti tra le email o aspettare risposte su WhatsApp \u2014 tutto \u00e8 in un unico posto, sempre disponibile.</p>

  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#166534">\ud83d\udccb Gestione LLC</h3>
    <table style="width:100%;border-collapse:collapse">
      ${row('\u2705', 'Documenti aziendali', 'Articles of Organization, Operating Agreement, EIN Letter, Lease sempre disponibili')}
      ${row('\u2705', 'Stato servizi', "Segui l'avanzamento di ogni pratica in tempo reale")}
      ${row('\u2705', 'Firma documenti', 'Firma Operating Agreement, Lease, SS-4 e altri direttamente online')}
      ${row('\u2705', 'Scadenze', 'Calendario con Annual Report, Rinnovo Registered Agent e Tax Filing')}
      ${row('\u2705', 'Documenti fiscali', 'Carica estratti conto e visualizza le dichiarazioni')}
      ${row('\u2705', 'Genera documenti', 'Crea Distribution Resolutions e Tax Statements per la tua LLC')}
    </table>
  </div>

  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#1e40af">\ud83d\udcbc Strumenti Business</h3>
    <table style="width:100%;border-collapse:collapse">
      ${row('\u2705', 'Fatturazione', 'Crea e invia fatture ai clienti della tua LLC direttamente dal portale')}
      ${row('\u2705', 'Gestione clienti', 'Un mini-CRM per organizzare i clienti della tua LLC')}
      ${row('\u2705', 'Pagamenti', 'Visualizza le nostre fatture e lo storico dei pagamenti')}
      ${row('\u2705', 'Richiedi servizi', 'Ordina nuovi servizi con un click')}
    </table>
  </div>

  <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#5b21b6">\ud83d\udcf1 Installa come App</h3>
    <p style="font-size:14px;color:#3f3f46;line-height:1.5;margin:0">Il portale pu\u00f2 essere installato come app sul tuo <strong>telefono</strong> e sul tuo <strong>computer</strong>, proprio come WhatsApp o Telegram. Riceverai notifiche push e potrai accedere con un tocco, senza aprire il browser.</p>
    <p style="font-size:13px;color:#71717a;margin:10px 0 0;line-height:1.5"><strong>iPhone/iPad:</strong> Apri il portale in Safari \u2192 tocca il pulsante Condividi \u2192 "Aggiungi alla schermata Home"<br><strong>Android:</strong> Apri il portale in Chrome \u2192 tocca il menu \u22ee \u2192 "Installa app"<br><strong>Computer:</strong> Apri il portale in Chrome \u2192 clicca l'icona di installazione nella barra degli indirizzi</p>
  </div>

  <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 8px;font-size:15px;color:#92400e">\ud83d\udcac Perch\u00e9 la chat del portale?</h3>
    <p style="font-size:14px;color:#78350f;margin:0 0 12px;line-height:1.5">Ti chiediamo di utilizzare la chat del portale per tutte le comunicazioni con noi, al posto di Telegram o WhatsApp.</p>
    <table style="width:100%;border-collapse:collapse">
      ${smallRow('\ud83d\udd12', 'Sicurezza', 'WhatsApp condivide i tuoi metadati con Meta (Facebook). Il portale \u00e8 un ambiente privato e protetto, dedicato esclusivamente a te.')}
      ${smallRow('\ud83d\udccb', 'Conformit\u00e0', 'Come studio professionale, siamo tenuti a tracciare e archiviare correttamente tutte le comunicazioni con i clienti.')}
      ${smallRow('\ud83d\udcc1', 'Tutto in un posto', 'Documenti, messaggi, firme e moduli sono collegati al tuo profilo. Niente pi\u00f9 file persi tra chat diverse.')}
      ${smallRow('\u26a1', 'Risposte pi\u00f9 rapide', 'Il nostro team vede subito a quale pratica si riferisce il tuo messaggio e pu\u00f2 risponderti pi\u00f9 velocemente.')}
      ${smallRow('\ud83c\udfa4', 'Dettatura vocale', 'Non devi nemmeno scrivere: premi il microfono e detta il messaggio con la voce. Il portale trascrive automaticamente.')}
    </table>
  </div>

  <div style="background:#f4f4f5;border:1px solid #d4d4d8;border-radius:10px;padding:20px;margin:24px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#18181b">\ud83d\udd10 Le tue credenziali di accesso</h3>
    <p style="margin:0 0 6px;font-size:14px;color:#3f3f46"><strong>Email:</strong> ${email}</p>
    <p style="margin:0 0 12px;font-size:14px;color:#3f3f46"><strong>Password temporanea:</strong> ${tempPassword}</p>
    <p style="margin:0;font-size:13px;color:#71717a">Al primo accesso ti verr\u00e0 chiesto di cambiare la password.</p>
  </div>

  <div style="text-align:center;margin:24px 0">
    <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;background:#2563eb;color:white;text-decoration:none;border-radius:10px;font-weight:bold;font-size:15px">Accedi al Portale</a>
  </div>

  <div style="border-top:1px solid #e5e7eb;padding-top:16px;margin-top:24px">
    <p style="font-size:13px;color:#a1a1aa;margin:0">Grazie per la fiducia,<br><strong>Tony Durante LLC</strong></p>
  </div>
</div>
</div>`
  }

  // English version
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
<div style="background:#18181b;padding:24px 28px;border-radius:12px 12px 0 0">
  <h1 style="color:white;margin:0;font-size:20px">Tony Durante LLC</h1>
  <p style="color:#a1a1aa;margin:6px 0 0;font-size:14px">Your New Client Portal</p>
</div>
<div style="background:white;border:1px solid #e5e7eb;border-top:none;padding:28px;border-radius:0 0 12px 12px">
  <p style="font-size:15px;color:#18181b">Hi ${name},</p>
  <p style="font-size:15px;color:#3f3f46;line-height:1.6">We've built a professional, secure platform dedicated to managing your LLC. No more searching for documents in emails or waiting for replies on WhatsApp \u2014 everything is in one place, always available.</p>

  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#166534">\ud83d\udccb LLC Management</h3>
    <table style="width:100%;border-collapse:collapse">
      ${row('\u2705', 'Company Documents', 'Articles of Organization, Operating Agreement, EIN Letter, Lease \u2014 always available')}
      ${row('\u2705', 'Service Tracking', 'Follow the progress of every service in real time')}
      ${row('\u2705', 'Sign Documents', 'Sign your Operating Agreement, Lease, SS-4 and more directly online')}
      ${row('\u2705', 'Deadlines', 'Calendar with Annual Report, Registered Agent Renewal, and Tax Filing due dates')}
      ${row('\u2705', 'Tax Documents', 'Upload bank statements and view your tax returns')}
      ${row('\u2705', 'Generate Documents', 'Create Distribution Resolutions and Tax Statements for your LLC')}
    </table>
  </div>

  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#1e40af">\ud83d\udcbc Business Tools</h3>
    <table style="width:100%;border-collapse:collapse">
      ${row('\u2705', 'Invoicing', "Create and send invoices to your LLC's clients directly from the portal")}
      ${row('\u2705', 'Customer Management', "A mini-CRM to organize your LLC's clients")}
      ${row('\u2705', 'Payments', 'View our invoices and your full payment history')}
      ${row('\u2705', 'Request Services', 'Order additional services with one click')}
    </table>
  </div>

  <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#5b21b6">\ud83d\udcf1 Install as App</h3>
    <p style="font-size:14px;color:#3f3f46;line-height:1.5;margin:0">The portal can be installed as an app on your <strong>phone</strong> and <strong>computer</strong>, just like WhatsApp or Telegram. You'll receive push notifications and can access it with one tap, without opening a browser.</p>
    <p style="font-size:13px;color:#71717a;margin:10px 0 0;line-height:1.5"><strong>iPhone/iPad:</strong> Open the portal in Safari \u2192 tap the Share button \u2192 "Add to Home Screen"<br><strong>Android:</strong> Open the portal in Chrome \u2192 tap the menu \u22ee \u2192 "Install app"<br><strong>Computer:</strong> Open the portal in Chrome \u2192 click the install icon in the address bar</p>
  </div>

  <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 8px;font-size:15px;color:#92400e">\ud83d\udcac Why portal chat?</h3>
    <p style="font-size:14px;color:#78350f;margin:0 0 12px;line-height:1.5">We strongly recommend using the portal chat for all communications with us, instead of Telegram or WhatsApp.</p>
    <table style="width:100%;border-collapse:collapse">
      ${smallRow('\ud83d\udd12', 'Privacy', 'WhatsApp shares your metadata with Meta (Facebook). Our portal is a private, secure environment dedicated exclusively to your account.')}
      ${smallRow('\ud83d\udccb', 'Compliance', 'As a professional services firm, we are required to track and archive all client communications properly.')}
      ${smallRow('\ud83d\udcc1', 'Everything in one place', 'Documents, messages, signatures, and forms are all linked to your profile. No more files lost across different chat apps.')}
      ${smallRow('\u26a1', 'Faster responses', 'Our team immediately sees which account your message is about and can respond faster.')}
      ${smallRow('\ud83c\udfa4', 'Voice dictation', "You don't even have to type: press the microphone button and dictate your message. The portal transcribes it automatically.")}
    </table>
  </div>

  <div style="background:#f4f4f5;border:1px solid #d4d4d8;border-radius:10px;padding:20px;margin:24px 0">
    <h3 style="margin:0 0 12px;font-size:15px;color:#18181b">\ud83d\udd10 Your login credentials</h3>
    <p style="margin:0 0 6px;font-size:14px;color:#3f3f46"><strong>Email:</strong> ${email}</p>
    <p style="margin:0 0 12px;font-size:14px;color:#3f3f46"><strong>Temporary Password:</strong> ${tempPassword}</p>
    <p style="margin:0;font-size:13px;color:#71717a">You will be asked to change your password on first login.</p>
  </div>

  <div style="text-align:center;margin:24px 0">
    <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;background:#2563eb;color:white;text-decoration:none;border-radius:10px;font-weight:bold;font-size:15px">Login to Portal</a>
  </div>

  <div style="border-top:1px solid #e5e7eb;padding-top:16px;margin-top:24px">
    <p style="font-size:13px;color:#a1a1aa;margin:0">Thank you for your trust,<br><strong>Tony Durante LLC</strong></p>
  </div>
</div>
</div>`
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
  // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw accounts.update portal_tier; extract to reconcileTier() in lib/operations/portal.ts per dev_task 7ebb1e0c
  await supabaseAdmin
    .from('accounts')
    .update({ portal_tier: newTier })
    .eq('id', accountId)

  // Also upgrade tier on all linked contacts (source of truth) and their auth users
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id')
    .eq('account_id', accountId)

  for (const link of links ?? []) {
    // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.update; extract to reconcileTier() in lib/operations/portal.ts per dev_task 7ebb1e0c
    await supabaseAdmin
      .from('contacts')
      // eslint-disable-next-line no-restricted-syntax -- Phase D1 contacts.portal_tier write; routes through reconcileTier() per dev_task 7ebb1e0c
      .update({ portal_tier: newTier })
      .eq('id', link.contact_id)

    // Sync to auth.users app_metadata so portal dashboard reads the correct tier
    const { data: contactRow } = await supabaseAdmin
      .from('contacts')
      .select('email')
      .eq('id', link.contact_id)
      .single()
    if (contactRow?.email) {
      const authUser = await findAuthUserByEmail(contactRow.email)
      if (authUser) {
        await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          app_metadata: { ...authUser.app_metadata, portal_tier: newTier },
        })
      }
    }
  }

  return { success: true, previousTier: account.portal_tier }
}
