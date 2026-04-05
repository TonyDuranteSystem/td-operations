import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { AccountDetail } from '@/components/accounts/account-detail'
import { isAdmin } from '@/lib/auth'
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
  const admin = user ? isAdmin(user) : false
  const today = new Date().toISOString().split('T')[0]

  // Fetch account
  const { data: account } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!account) notFound()

  // Fetch related data in parallel
  const [contactsResult, servicesResult, paymentsResult, dealsResult, taxReturnsResult, documentsResult] = await Promise.all([
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
      .neq('status', 'Cancelled')
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
      />
    </div>
  )
}
