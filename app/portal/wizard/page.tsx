/**
 * Portal Wizard Page — Data collection inside the portal.
 *
 * Server component that:
 * 1. Gets the logged-in user's account/contact
 * 2. Determines wizard type from service deliveries or offer
 * 3. Loads saved progress from wizard_progress table
 * 4. Renders the appropriate wizard
 */

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { WizardClient } from './wizard-client'

export default async function WizardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">Please log in.</p>
      </div>
    )
  }

  const contactId = getClientContactId(user)
  const locale = getLocale(user)

  // Get selected account from cookie
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value

  // Get contact details for prefilling
  let contact: Record<string, string> = {}
  if (contactId) {
    const { data: c } = await supabaseAdmin
      .from('contacts')
      .select('full_name, first_name, last_name, email, phone, citizenship, date_of_birth, address_line1, address_city, address_state, address_zip, address_country, itin, itin_issue_date')
      .eq('id', contactId)
      .single()
    if (c) contact = c as unknown as Record<string, string>
  }

  // Get account details
  let account: Record<string, string> = {}
  let accountId = cookieAccountId || ''
  if (contactId) {
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contactId)

    if (links?.length) {
      const targetId = cookieAccountId && links.find(l => l.account_id === cookieAccountId)
        ? cookieAccountId
        : links[0].account_id
      accountId = targetId

      const { data: a } = await supabaseAdmin
        .from('accounts')
        .select('company_name, state_of_formation, formation_date, ein, filing_id, entity_type, portal_tier')
        .eq('id', targetId)
        .single()
      if (a) account = a as unknown as Record<string, string>
    }
  }

  // Determine wizard type from offer or service deliveries
  let wizardType = 'onboarding' // default
  let entityType = account.entity_type || 'SMLLC'

  // Check if there's a pending formation SD
  if (accountId) {
    const { data: sds } = await supabaseAdmin
      .from('service_deliveries')
      .select('service_type')
      .eq('account_id', accountId)
      .in('status', ['active'])
      .limit(5)

    const types = (sds || []).map(s => s.service_type)
    if (types.includes('Company Formation')) wizardType = 'formation'
  }

  // Also check via lead/offer (for leads without account)
  if (wizardType === 'onboarding') {
    // Collect all emails to search
    const searchEmails = new Set<string>()
    if (user.email) searchEmails.add(user.email)
    if (contact.email) searchEmails.add(contact.email)
    const emailArr = Array.from(searchEmails)

    if (emailArr.length > 0) {
      // Try to find lead by email
      const { data: leads } = await supabaseAdmin
        .from('leads')
        .select('id')
        .in('email', emailArr)
        .limit(1)

      const leadId = leads?.[0]?.id
      if (leadId) {
        const { data: offer } = await supabaseAdmin
          .from('offers')
          .select('contract_type, bundled_pipelines')
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (offer?.contract_type) {
          if (offer.contract_type === 'formation') wizardType = 'formation'
          else if (offer.contract_type === 'tax_return') wizardType = 'tax'
          else if (offer.contract_type === 'itin') wizardType = 'itin'
        }
      }

      // Also try directly via offer client_email
      if (wizardType === 'onboarding') {
        const { data: directOffer } = await supabaseAdmin
          .from('offers')
          .select('contract_type')
          .in('client_email', emailArr)
          .not('status', 'eq', 'expired')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (directOffer?.contract_type === 'formation') wizardType = 'formation'
        else if (directOffer?.contract_type === 'tax_return') wizardType = 'tax'
        else if (directOffer?.contract_type === 'itin') wizardType = 'itin'
      }
    }
  }

  // Load saved progress
  let savedData: Record<string, unknown> = {}
  let savedStep = 0
  let progressId: string | null = null

  const progressQuery = accountId
    ? supabaseAdmin.from('wizard_progress').select('*').eq('account_id', accountId).eq('wizard_type', wizardType).eq('status', 'in_progress').limit(1).maybeSingle()
    : contactId
      ? supabaseAdmin.from('wizard_progress').select('*').eq('contact_id', contactId).eq('wizard_type', wizardType).eq('status', 'in_progress').limit(1).maybeSingle()
      : null

  if (progressQuery) {
    const { data: progress } = await progressQuery
    if (progress) {
      savedData = (progress.data as Record<string, unknown>) || {}
      savedStep = progress.current_step || 0
      progressId = progress.id
    }
  }

  // Build prefill data from contact + account
  const prefillData: Record<string, string> = {}
  if (contact.first_name) prefillData.owner_first_name = contact.first_name
  if (contact.last_name) prefillData.owner_last_name = contact.last_name
  if (contact.email) prefillData.owner_email = contact.email
  if (contact.phone) prefillData.owner_phone = contact.phone
  if (contact.date_of_birth) prefillData.owner_dob = contact.date_of_birth
  if (contact.citizenship) prefillData.owner_nationality = contact.citizenship
  if (contact.address_line1) prefillData.owner_street = contact.address_line1
  if (contact.address_city) prefillData.owner_city = contact.address_city
  if (contact.address_state) prefillData.owner_state_province = contact.address_state
  if (contact.address_zip) prefillData.owner_zip = contact.address_zip
  if (contact.address_country) prefillData.owner_country = contact.address_country
  if (contact.itin) prefillData.owner_itin = contact.itin
  if (contact.itin_issue_date) prefillData.owner_itin_issue_date = contact.itin_issue_date
  if (account.company_name) prefillData.company_name = account.company_name
  if (account.state_of_formation) prefillData.state_of_formation = account.state_of_formation
  if (account.formation_date) prefillData.formation_date = account.formation_date
  if (account.ein) prefillData.ein = account.ein
  if (account.filing_id) prefillData.filing_id = account.filing_id

  // Normalize entity type
  if (entityType === 'Single Member LLC') entityType = 'SMLLC'
  if (entityType === 'Multi-Member LLC') entityType = 'MMLLC'

  return (
    <div className="px-4 py-6 lg:px-8">
      <WizardClient
        wizardType={wizardType}
        entityType={entityType}
        prefillData={prefillData}
        savedData={savedData as Record<string, string>}
        savedStep={savedStep}
        progressId={progressId}
        accountId={accountId}
        contactId={contactId || ''}
        locale={locale}
      />
    </div>
  )
}
