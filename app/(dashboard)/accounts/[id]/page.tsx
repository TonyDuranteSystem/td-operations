import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { notFound } from 'next/navigation'
import { AccountDetail } from '@/components/accounts/account-detail'
import { isDashboardUser } from '@/lib/auth'
import { getBankReferralsForAccount } from '@/lib/bank-referrals'
import type { Account, Contact, Service, Payment, Deal, TaxReturn } from '@/lib/types'

interface DocumentRecord {
  id: string
  file_name: string
  document_type_name: string | null
  category_name: string | null
  category: number | null
  confidence: string | null
  drive_file_id: string | null
  drive_link: string | null
  status: string | null
  processed_at: string | null
  mime_type: string | null
  file_size: number | null
  portal_visible: boolean
}

export default async function AccountDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = user ? isDashboardUser(user) : false
  const today = new Date().toISOString().split('T')[0]

  // Fetch account
  const { data: account } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!account) notFound()

  // Fetch partner name if linked
  let partnerName: string | null = null
  if (account.partner_id) {
    const { data: partner } = await supabaseAdmin
      .from('client_partners')
      .select('partner_name')
      .eq('id', account.partner_id)
      .single()
    partnerName = partner?.partner_name ?? null
  }

  // Fetch related data in parallel
  const [contactsResult, servicesResult, paymentsResult, dealsResult, taxReturnsResult, documentsResult, offerResult, , wizardProgressResult] = await Promise.all([
    // Contacts via junction table
    supabase
      .from('account_contacts')
      .select('role, contact:contacts(*)')
      .eq('account_id', params.id),
    // Services (from service_deliveries — source of truth)
    supabase
      .from('service_deliveries')
      .select('id, service_name, service_type, stage, status, start_date, end_date, notes, updated_at, account_id')
      .eq('account_id', params.id)
      .neq('status', 'cancelled')
      .order('updated_at', { ascending: false }),
    // Payments
    supabase
      .from('payments')
      .select('id, description, amount, amount_currency, period, year, due_date, paid_date, status, payment_method, invoice_number, installment, amount_paid, amount_due, followup_stage, notes, updated_at, invoice_status, portal_invoice_id, total')
      .eq('account_id', params.id)
      .order('due_date', { ascending: false }),
    // Deals
    supabase
      .from('deals')
      .select('id, deal_name, stage, amount, amount_currency, close_date, deal_type, deal_category, service_type, payment_status, notes, created_at, updated_at')
      .eq('account_id', params.id)
      .order('created_at', { ascending: false }),
    // Tax Returns (matched by company_name)
    supabase
      .from('tax_returns')
      .select('id, company_name, client_name, return_type, tax_year, deadline, status, paid, data_received, sent_to_india, india_status, special_case, extension_filed, extension_deadline, notes, updated_at')
      .eq('company_name', account.company_name)
      .order('tax_year', { ascending: false }),
    // Documents
    supabase
      .from('documents')
      .select('id, file_name, document_type_name, category_name, category, confidence, drive_file_id, drive_link, status, processed_at, mime_type, file_size, portal_visible')
      .eq('account_id', params.id)
      .order('processed_at', { ascending: false }),
    // Offer (latest for this account)
    supabase
      .from('offers')
      .select('token, status, contract_type, cost_summary, view_count, viewed_at, created_at, required_documents')
      .eq('account_id', params.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Pending activation (for journey tracker — fetched after offer token is known)
    Promise.resolve({ data: null }),
    // Wizard progress (for journey tracker — fetch ALL wizards)
    supabaseAdmin
      .from('wizard_progress')
      .select('status, current_step, wizard_type, updated_at, account_id, data')
      .eq('account_id', params.id)
      .order('updated_at', { ascending: false }),
  ])

  const contacts: Contact[] = (contactsResult.data ?? []).map(c => {
    const contact = c.contact as unknown as Contact
    return { ...contact, role: c.role }
  })

  const services: Service[] = (servicesResult.data ?? []).map(sd => ({
    id: sd.id,
    service_name: sd.service_name ?? sd.service_type ?? 'Service',
    service_type: sd.service_type ?? '',
    account_id: sd.account_id,
    status: sd.status === 'active' ? 'In Progress' : sd.status === 'completed' ? 'Completed' : sd.status,
    start_date: sd.start_date ?? null,
    end_date: sd.end_date ?? null,
    billing_type: null,
    amount: null,
    amount_currency: null,
    current_step: null,
    total_steps: null,
    blocked_waiting_external: null,
    blocked_reason: null,
    sla_due_date: null,
    notes: sd.notes ?? null,
    updated_at: sd.updated_at,
  })) as Service[]
  const payments: Payment[] = (paymentsResult.data ?? []).map(p => ({ ...p, account_id: params.id })) as unknown as Payment[]
  const deals: Deal[] = (dealsResult.data ?? []).map(d => ({ ...d, account_id: params.id })) as Deal[]
  const taxReturns: TaxReturn[] = (taxReturnsResult.data ?? []) as TaxReturn[]
  const documents = (documentsResult.data ?? []) as DocumentRecord[]
  const offer = offerResult.data as {
    token: string
    status: string
    contract_type: string | null
    cost_summary: Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null
    view_count: number
    viewed_at: string | null
    created_at: string
    required_documents: Array<{ id: string; name: string }> | null
  } | null

  // Fetch pending activation for this offer (if exists)
  let pendingActivation: {
    signed_at: string | null
    payment_confirmed_at: string | null
    payment_method: string | null
    activated_at: string | null
    status: string | null
  } | null = null

  if (offer?.token) {
    const { data: pa } = await supabaseAdmin
      .from('pending_activations')
      .select('signed_at, payment_confirmed_at, payment_method, activated_at, status')
      .eq('offer_token', offer.token)
      .maybeSingle()
    pendingActivation = pa
  }

  const allWizardEntries = (wizardProgressResult.data ?? []) as Array<{
    status: string
    current_step: number
    wizard_type: string
    updated_at: string
    data: Record<string, unknown> | null
  }>

  // Merge canonical "data received" signals from the domain tables into the
  // wizard-card feed. The Client Wizard Submissions card used to read only
  // wizard_progress — but for every wizard type there's a domain-specific
  // completion signal that's authoritative regardless of channel (CRM flip,
  // India-team handoff, legacy import, portal wizard submit). Without this,
  // the card shows "Not Started" for accounts whose data IS received.
  //
  // Canonical signals per wizard type:
  //   tax             — tax_returns.data_received = true (any year)
  //   banking_payset  — banking_submissions.provider='payset' + completed_at
  //   banking_relay   — banking_submissions.provider='relay'  + completed_at
  //   itin            — itin_submissions.completed_at
  //   formation       — formation_submissions.completed_at (via contact_id)
  //   onboarding      — onboarding_submissions.completed_at
  //   closure         — closure_submissions.completed_at
  //
  // We fetch all submissions for this account in parallel, then UPSERT one
  // "submitted" entry per wizard type if the canonical signal says yes and
  // no wizard_progress row already has a submitted entry for that type.
  const contactIds = contacts.map(c => c.id).filter(Boolean) as string[]
  const contactIdList = contactIds.length ? contactIds.map(id => `"${id}"`).join(',') : '"00000000-0000-0000-0000-000000000000"'

  const [bankingRes, itinRes, formationRes, onboardingRes, closureRes] = await Promise.all([
    supabaseAdmin
      .from('banking_submissions')
      .select('provider, completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false }),
    supabaseAdmin
      .from('itin_submissions')
      .select('completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1),
    contactIds.length
      ? supabaseAdmin
          .from('formation_submissions')
          .select('completed_at, status, updated_at, contact_id')
          .in('contact_id', contactIds)
          .not('completed_at', 'is', null)
          .order('completed_at', { ascending: false })
          .limit(1)
      : Promise.resolve({ data: [] }),
    supabaseAdmin
      .from('onboarding_submissions')
      .select('completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1),
    supabaseAdmin
      .from('closure_submissions')
      .select('completed_at, status, updated_at')
      .eq('account_id', params.id)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1),
  ])
  // Touch contactIdList so linter doesn't flag (unused fallback for typing)
  void contactIdList

  type WizardEntry = (typeof allWizardEntries)[number]
  const syntheticEntries: WizardEntry[] = []

  // Tax — tax_returns.data_received=true, latest updated_at
  const latestReceivedTR = [...taxReturns]
    .filter(tr => tr.data_received === true)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0]
  if (latestReceivedTR) {
    syntheticEntries.push({
      status: 'submitted',
      current_step: 0,
      wizard_type: 'tax',
      updated_at: latestReceivedTR.updated_at ?? new Date().toISOString(),
      data: null,
    })
  }

  // Banking — one entry per provider if that provider has a completed submission
  const bankingRows = (bankingRes.data ?? []) as Array<{ provider: string | null; completed_at: string | null; updated_at: string | null }>
  const latestPayset = bankingRows.find(r => r.provider === 'payset')
  const latestRelay = bankingRows.find(r => r.provider === 'relay')
  if (latestPayset) syntheticEntries.push({ status: 'submitted', current_step: 0, wizard_type: 'banking_payset', updated_at: latestPayset.completed_at ?? latestPayset.updated_at ?? new Date().toISOString(), data: null })
  if (latestRelay) syntheticEntries.push({ status: 'submitted', current_step: 0, wizard_type: 'banking_relay', updated_at: latestRelay.completed_at ?? latestRelay.updated_at ?? new Date().toISOString(), data: null })

  // Single-type wizards — each maps one-to-one with its submissions table
  const pushLatest = (wizardType: string, row: { completed_at: string | null; updated_at: string | null } | undefined) => {
    if (!row) return
    syntheticEntries.push({ status: 'submitted', current_step: 0, wizard_type: wizardType, updated_at: row.completed_at ?? row.updated_at ?? new Date().toISOString(), data: null })
  }
  pushLatest('itin', (itinRes.data ?? [])[0])
  pushLatest('formation', (formationRes.data ?? [])[0])
  pushLatest('onboarding', (onboardingRes.data ?? [])[0])
  pushLatest('closure', (closureRes.data ?? [])[0])

  // Only add a synthetic entry if wizard_progress doesn't already have a
  // submitted row for that type — wizard_progress wins because it has the
  // actual submitted_data payload for export.
  const existingSubmittedTypes = new Set(
    allWizardEntries.filter(e => e.status === 'submitted').map(e => e.wizard_type),
  )
  for (const s of syntheticEntries) {
    if (!existingSubmittedTypes.has(s.wizard_type)) allWizardEntries.unshift(s)
  }

  // Partner-bank referrals (Model B): banks where clients apply directly via
  // an external link. TD only sees click-through events. Centralised in
  // lib/bank-referrals.ts because the generated Supabase types don't include
  // these tables yet (TS "excessively deep" error otherwise).
  const bankReferrals = await getBankReferralsForAccount(params.id)

  // For backward compat: wizardProgress = the most recent submitted/in_progress wizard
  const wizardProgress = allWizardEntries.length > 0 ? allWizardEntries[0] : null

  // Service deliveries for journey (need stage/pipeline data)
  const serviceDeliveriesRaw = (servicesResult.data ?? []).map(sd => ({
    status: sd.status,
    stage: sd.stage ?? null,
    pipeline: null as string | null,
    service_name: sd.service_name ?? sd.service_type ?? null,
  }))

  return (
    <div className="p-6 lg:p-8">
      <AccountDetail
        account={account as Account}
        contacts={contacts}
        services={services}
        payments={payments}
        deals={deals}
        taxReturns={taxReturns}
        documents={documents}
        today={today}
        isAdmin={admin}
        offer={offer}
        partnerName={partnerName}
        pendingActivation={pendingActivation}
        wizardProgress={wizardProgress}
        serviceDeliveriesRaw={serviceDeliveriesRaw}
        allWizards={allWizardEntries}
        bankReferrals={bankReferrals}
      />
    </div>
  )
}
