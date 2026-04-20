import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { notFound } from 'next/navigation'
import { AccountDetail } from '@/components/accounts/account-detail'
import { isDashboardUser } from '@/lib/auth'
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

  // Synthesize a tax-wizard entry when tax_returns.data_received=true but no
  // wizard_progress row exists for this account. This happens for accounts
  // whose data was marked received pre-wizard (legacy flows, manual CRM
  // flips, or cloned from systems that never wrote to wizard_progress).
  // Without this, the Client Wizard Submissions card reads "Not Started"
  // even though the client has already submitted the data — stale and
  // misleading for Antonio/Luca.
  const hasDataReceivedTR = taxReturns.some(tr => tr.data_received === true)
  const hasTaxWizardEntry = allWizardEntries.some(w => w.wizard_type === 'tax' || w.wizard_type === 'tax_return')
  if (hasDataReceivedTR && !hasTaxWizardEntry) {
    const latest = [...taxReturns]
      .filter(tr => tr.data_received)
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0]
    allWizardEntries.unshift({
      status: 'submitted',
      current_step: 0,
      wizard_type: 'tax',
      updated_at: latest?.updated_at ?? new Date().toISOString(),
      data: null,
    })
  }

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
      />
    </div>
  )
}
