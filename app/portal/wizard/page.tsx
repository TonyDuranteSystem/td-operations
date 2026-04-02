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

const VALID_WIZARD_TYPES = ['onboarding', 'formation', 'banking', 'closure', 'itin', 'tax'] as const
type WizardType = typeof VALID_WIZARD_TYPES[number]

function isValidWizardType(type: string | undefined): type is WizardType {
  return VALID_WIZARD_TYPES.includes(type as WizardType)
}

export default async function WizardPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
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
      .select('full_name, first_name, last_name, email, phone, citizenship, date_of_birth, itin_number, itin_issue_date')
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
        .select('company_name, state_of_formation, formation_date, ein_number, filing_id, entity_type, portal_tier')
        .eq('id', targetId)
        .single()
      if (a) account = a as unknown as Record<string, string>
    }
  }

  // Allow explicit type override via ?type= query param (e.g. from tax banner)
  const { type: typeParam } = await searchParams
  const forcedType = isValidWizardType(typeParam) ? typeParam : null

  // Determine wizard type from offer or service deliveries
  let wizardType: WizardType = forcedType || 'onboarding'
  let entityType = account.entity_type || 'SMLLC'
  let isItinRenewal = false

  // Collect ALL pending wizard types from service deliveries
  const pendingWizardTypes: { type: WizardType; label: string; serviceType: string }[] = []

  if (!forcedType && accountId) {
    const { data: sds } = await supabaseAdmin
      .from('service_deliveries')
      .select('service_type')
      .eq('account_id', accountId)
      .in('status', ['active'])
      .limit(10)

    const types = (sds || []).map(s => s.service_type)

    // Check which wizard types have already been submitted
    const { data: submittedWizards } = await supabaseAdmin
      .from('wizard_progress')
      .select('wizard_type, status')
      .eq('account_id', accountId)
      .in('status', ['submitted'])

    const submittedTypes = new Set((submittedWizards || []).map(w => w.wizard_type))

    // Build list of ALL applicable wizard types (both pending and submitted)
    if (types.includes('Company Formation')) {
      pendingWizardTypes.push({ type: 'formation', label: 'LLC Formation', serviceType: 'Company Formation' })
    }
    if (types.includes('Banking Fintech')) {
      pendingWizardTypes.push({ type: 'banking', label: 'Banking Application', serviceType: 'Banking Fintech' })
    }
    if (types.includes('Company Closure')) {
      pendingWizardTypes.push({ type: 'closure', label: 'Company Closure', serviceType: 'Company Closure' })
    }
    if (types.includes('ITIN Renewal')) {
      pendingWizardTypes.push({ type: 'itin', label: 'ITIN Renewal', serviceType: 'ITIN Renewal' })
      isItinRenewal = true
    } else if (types.includes('ITIN')) {
      pendingWizardTypes.push({ type: 'itin', label: 'ITIN Application', serviceType: 'ITIN' })
    }
    if (types.includes('Tax Return')) {
      pendingWizardTypes.push({ type: 'tax', label: 'Tax Return', serviceType: 'Tax Return' })
    }

    // If only one pending wizard, use it directly
    if (pendingWizardTypes.length === 1) {
      wizardType = pendingWizardTypes[0].type
      if (pendingWizardTypes[0].type === 'itin' && types.includes('ITIN Renewal')) isItinRenewal = true
    } else if (pendingWizardTypes.length > 1) {
      // Multiple wizards — filter out already-submitted ones for auto-selection
      const unsubmitted = pendingWizardTypes.filter(w => !submittedTypes.has(w.type))
      if (unsubmitted.length === 1) {
        // Only one unsubmitted — go directly to it
        wizardType = unsubmitted[0].type
      } else if (unsubmitted.length > 1) {
        // Multiple unsubmitted — pick first one as default but we'll show selection
        wizardType = unsubmitted[0].type
      } else {
        // All submitted — show the first one for review
        wizardType = pendingWizardTypes[0].type
      }
    }
  }

  // Also check via lead/offer (for leads without account, skip if type was forced)
  if (!forcedType && wizardType === 'onboarding') {
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

  // Load saved progress — include 'submitted' so clients can edit before review
  let savedData: Record<string, unknown> = {}
  let savedStep = 0
  let progressId: string | null = null
  let wizardSubmitStatus: 'in_progress' | 'submitted' | null = null

  const progressQuery = accountId
    ? supabaseAdmin.from('wizard_progress').select('*').eq('account_id', accountId).eq('wizard_type', wizardType).in('status', ['in_progress', 'submitted']).order('updated_at', { ascending: false }).limit(1).maybeSingle()
    : contactId
      ? supabaseAdmin.from('wizard_progress').select('*').eq('contact_id', contactId).eq('wizard_type', wizardType).in('status', ['in_progress', 'submitted']).order('updated_at', { ascending: false }).limit(1).maybeSingle()
      : null

  if (progressQuery) {
    const { data: progress } = await progressQuery
    if (progress) {
      savedData = (progress.data as Record<string, unknown>) || {}
      // Cap current_step (submitted records may have step=99)
      savedStep = Math.min(progress.current_step || 0, 20)
      progressId = progress.id
      wizardSubmitStatus = progress.status as 'in_progress' | 'submitted'
    }
  }

  // For submitted tax wizards: lock only when sent_to_india=true (processing started)
  let isLocked = false
  if (wizardSubmitStatus === 'submitted' && wizardType === 'tax' && accountId) {
    const { data: sentTr } = await supabaseAdmin
      .from('tax_returns')
      .select('id')
      .eq('account_id', accountId)
      .eq('sent_to_india', true)
      .limit(1)
      .maybeSingle()
    isLocked = !!sentTr
  }

  // Build prefill data from contact + account
  const prefillData: Record<string, string> = {}
  if (contact.first_name) prefillData.owner_first_name = contact.first_name
  if (contact.last_name) prefillData.owner_last_name = contact.last_name
  if (contact.email) prefillData.owner_email = contact.email
  if (contact.phone) prefillData.owner_phone = contact.phone
  if (contact.date_of_birth) prefillData.owner_dob = contact.date_of_birth
  if (contact.citizenship) { prefillData.owner_nationality = contact.citizenship; prefillData.owner_tax_residency = contact.citizenship }
  if (contact.itin_number) prefillData.owner_itin = contact.itin_number
  if (contact.itin_issue_date) prefillData.owner_itin_issue_date = contact.itin_issue_date
  // Banking-specific prefills
  if (contact.first_name) prefillData.first_name = contact.first_name
  if (contact.last_name) prefillData.last_name = contact.last_name
  if (contact.email) { prefillData.email = contact.email; prefillData.personal_email = contact.email }
  if (contact.phone) { prefillData.phone = contact.phone; prefillData.personal_phone = contact.phone }
  if (contact.citizenship) prefillData.personal_country = contact.citizenship
  if (account.company_name) { prefillData.business_name = account.company_name; prefillData.company_name = account.company_name; prefillData.llc_name = account.company_name }
  if (account.ein_number) { prefillData.ein = account.ein_number; prefillData.llc_ein = account.ein_number; prefillData.ein_number = account.ein_number }
  if (account.state_of_formation) { prefillData.state_of_formation = account.state_of_formation; prefillData.state_of_incorporation = account.state_of_formation }
  if (account.formation_date) { prefillData.formation_date = account.formation_date; prefillData.date_of_incorporation = account.formation_date }
  if (account.filing_id) prefillData.filing_id = account.filing_id

  // ITIN Renewal: pre-fill previous ITIN from contact
  if (isItinRenewal && contact.itin_number) {
    prefillData.has_previous_itin = 'Yes'
    prefillData.previous_itin = contact.itin_number
  }

  // Normalize entity type
  if (entityType === 'Single Member LLC') entityType = 'SMLLC'
  if (entityType === 'Multi-Member LLC') entityType = 'MMLLC'

  // Build wizard list with submission status for the selector
  // Query all wizard progress for this account to know which are submitted
  let allSubmittedTypes = new Set<string>()
  if (accountId && pendingWizardTypes.length > 1) {
    const { data: allProgress } = await supabaseAdmin
      .from('wizard_progress')
      .select('wizard_type, status')
      .eq('account_id', accountId)
      .eq('status', 'submitted')
    allSubmittedTypes = new Set((allProgress || []).map(p => p.wizard_type))
  }
  const wizardList = pendingWizardTypes.map(w => ({
    ...w,
    submitted: allSubmittedTypes.has(w.type),
  }))

  return (
    <div className="px-4 py-6 lg:px-8">
      {/* Show form selector when multiple wizards are pending */}
      {wizardList.length > 1 && !forcedType && (
        <div className="mb-6 border rounded-lg bg-white p-4">
          <p className="text-sm font-medium text-zinc-700 mb-3">
            {locale === 'it' ? 'Moduli da compilare:' : 'Forms to complete:'}
          </p>
          <div className="flex flex-wrap gap-2">
            {wizardList.map(w => {
              const isCurrent = w.type === wizardType
              return (
                <a
                  key={w.type}
                  href={`/portal/wizard?type=${w.type}`}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isCurrent
                      ? 'bg-blue-600 text-white'
                      : w.submitted
                        ? 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'
                        : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                  }`}
                >
                  {w.submitted && <span>&#10003;</span>}
                  {w.label}
                </a>
              )
            })}
          </div>
        </div>
      )}
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
        initialSubmitStatus={wizardSubmitStatus}
        isLocked={isLocked}
      />
    </div>
  )
}
