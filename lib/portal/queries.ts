import { supabaseAdmin } from '@/lib/supabase-admin'
import type { PortalAccount, PortalService } from '@/lib/types'

/**
 * Portal data queries. All use supabaseAdmin (service role, bypasses RLS)
 * with manual account_id filtering. This is intentional — existing RLS policies
 * are permissive (allow all authenticated). Portal isolation is enforced here.
 */

export async function getPortalAccounts(contactId: string): Promise<PortalAccount[]> {
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id, role')
    .eq('contact_id', contactId)

  if (!links || links.length === 0) return []

  const accountIds = links.map(l => l.account_id)
  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address')
    .in('id', accountIds)
    .eq('status', 'Active')
    .order('company_name')

  return (accounts ?? []) as PortalAccount[]
}

export async function getPortalAccountDetail(accountId: string) {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, registered_agent_provider, registered_agent_address, ra_renewal_date, filing_id, invoice_logo_url, bank_details, payment_gateway, payment_link')
    .eq('id', accountId)
    .single()

  return data
}

export async function getPortalMembers(accountId: string) {
  const { data } = await supabaseAdmin
    .from('account_contacts')
    .select('role, ownership_pct, contacts(first_name, last_name, email, phone)')
    .eq('account_id', accountId)

  return (data ?? []).map(d => {
    const c = d.contacts as unknown as { first_name: string; last_name: string; email: string | null; phone: string | null } | null
    return {
      role: d.role,
      ownership_pct: d.ownership_pct,
      first_name: c?.first_name ?? '',
      last_name: c?.last_name ?? '',
      email: c?.email ?? null,
      phone: c?.phone ?? null,
    }
  })
}

export async function getPortalServices(accountId: string): Promise<PortalService[]> {
  const { data } = await supabaseAdmin
    .from('services')
    .select('id, service_name, service_type, status, current_step, total_steps, blocked_waiting_external, blocked_reason, start_date')
    .eq('account_id', accountId)
    .in('status', ['Not Started', 'In Progress', 'Waiting Client', 'Waiting Third Party', 'Completed'])
    .order('updated_at', { ascending: false })

  // Get current_stage from service_deliveries (linked by account_id + service_name)
  let stageMap: Record<string, string> = {}

  if ((data ?? []).length > 0) {
    const { data: deliveries } = await supabaseAdmin
      .from('service_deliveries')
      .select('service_name, stage')
      .eq('account_id', accountId)

    if (deliveries) {
      stageMap = Object.fromEntries(deliveries.map(d => [d.service_name, d.stage]))
    }
  }

  return (data ?? []).map(s => ({
    ...s,
    current_stage: stageMap[s.service_name] ?? null,
  })) as PortalService[]
}

export async function getPortalServicesByContact(contactId: string): Promise<PortalService[]> {
  // For contact-only clients (ITIN, no LLC), query service_deliveries directly by contact_id
  const { data } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, service_type, stage, status, assigned_to, start_date, updated_at')
    .eq('contact_id', contactId)
    .in('status', ['active', 'completed'])
    .order('updated_at', { ascending: false })

  return (data ?? []).map(sd => ({
    id: sd.id,
    service_name: sd.service_name ?? sd.service_type ?? 'Service',
    service_type: sd.service_type ?? '',
    status: sd.status === 'active' ? 'In Progress' : 'Completed',
    current_step: null,
    total_steps: null,
    blocked_waiting_external: false,
    blocked_reason: null,
    start_date: sd.start_date,
    current_stage: sd.stage,
  })) as PortalService[]
}

export async function getPortalDeadlines(accountId: string) {
  const sixtyDaysLater = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0]

  const { data } = await supabaseAdmin
    .from('deadlines')
    .select('id, deadline_type, due_date, status, notes')
    .eq('account_id', accountId)
    .in('status', ['Pending', 'Overdue'])
    .lte('due_date', sixtyDaysLater)
    .order('due_date', { ascending: true })
    .limit(10)

  return data ?? []
}

export async function getPortalPayments(accountId: string) {
  const { data } = await supabaseAdmin
    .from('payments')
    .select('id, description, amount, amount_currency, period, year, due_date, paid_date, status, installment')
    .eq('account_id', accountId)
    .order('due_date', { ascending: false })
    .limit(20)

  return data ?? []
}

/**
 * Get TD LLC invoices sent to this client account (from CRM payments table).
 * These are invoices Tony Durante LLC sent TO the client, not the client's own invoices.
 */
export async function getPortalBilling(accountId: string) {
  const { data } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, invoice_status, description, total, amount, amount_currency, issue_date, due_date, paid_date, sent_at, message, payment_items(description, quantity, unit_price, amount)')
    .eq('account_id', accountId)
    .not('invoice_status', 'is', null)
    .order('issue_date', { ascending: false })
    .limit(50)

  return data ?? []
}

/**
 * Get active service_deliveries for this account to drive portal nav visibility.
 * Returns service names so the sidebar can show/hide sections.
 */
export async function getPortalActiveServices(accountId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('service_deliveries')
    .select('service_name')
    .eq('account_id', accountId)
    .in('stage', ['Active', 'Intake', 'Setup', 'Processing', 'Review'])

  return (data ?? []).map(d => d.service_name)
}

/**
 * Nav visibility flags based on actual data.
 * Each flag tells the sidebar whether to show a nav item.
 */
export interface PortalNavVisibility {
  services: boolean       // has any services or SDs
  billing: boolean        // has invoices from TD LLC
  invoices: boolean       // has client invoicing feature (client_invoices or client_customers)
  taxDocuments: boolean   // has tax-related SD or tax return
  deadlines: boolean      // has any pending/overdue deadlines
  documents: boolean      // always true (every client can upload docs)
  customers: boolean      // same as invoices
  pendingSignatures: boolean  // has unsigned OA or Lease agreements
}

export async function getPortalNavVisibility(accountId: string): Promise<PortalNavVisibility> {
  // Run all checks in parallel
  const [
    serviceDeliveries,
    billingCount,
    clientInvoiceCount,
    clientCustomerCount,
    deadlineCount,
    taxReturnCount,
    unsignedDocCount,
  ] = await Promise.all([
    // Active SDs
    supabaseAdmin
      .from('service_deliveries')
      .select('service_name', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .then(r => ({
        count: r.count ?? 0,
        names: [] as string[],
      })),
    // TD LLC invoices sent to client
    supabaseAdmin
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .not('invoice_status', 'is', null)
      .then(r => r.count ?? 0),
    // Client's own invoices
    supabaseAdmin
      .from('client_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .then(r => r.count ?? 0),
    // Client's customers
    supabaseAdmin
      .from('client_customers')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .then(r => r.count ?? 0),
    // Pending deadlines
    supabaseAdmin
      .from('deadlines')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .in('status', ['Pending', 'Overdue'])
      .then(r => r.count ?? 0),
    // Tax returns (need company_name lookup)
    supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', accountId)
      .single()
      .then(async ({ data: acct }) => {
        if (!acct?.company_name) return 0
        const { count } = await supabaseAdmin
          .from('tax_returns')
          .select('id', { count: 'exact', head: true })
          .eq('company_name', acct.company_name)
        return count ?? 0
      }),
    // Unsigned OA, Lease, or SS-4 agreements
    Promise.all([
      supabaseAdmin
        .from('oa_agreements')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'signed'),
      supabaseAdmin
        .from('lease_agreements')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'signed'),
      supabaseAdmin
        .from('ss4_applications')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .in('status', ['awaiting_signature', 'draft']),
    ]).then(([oa, lease, ss4]) => (oa.count ?? 0) + (lease.count ?? 0) + (ss4.count ?? 0)),
  ])

  // Also check if any SD is tax-related
  const { data: taxSDs } = await supabaseAdmin
    .from('service_deliveries')
    .select('service_name')
    .eq('account_id', accountId)
    .ilike('service_name', '%tax%')
    .limit(1)

  const hasTaxSD = (taxSDs ?? []).length > 0
  const hasInvoicing = clientInvoiceCount > 0 || clientCustomerCount > 0

  return {
    services: serviceDeliveries.count > 0,
    billing: billingCount > 0,
    invoices: hasInvoicing,
    taxDocuments: hasTaxSD || taxReturnCount > 0,
    deadlines: deadlineCount > 0,
    documents: true, // always available
    customers: hasInvoicing,
    pendingSignatures: unsignedDocCount > 0,
  }
}

/**
 * Get the portal tier for an account.
 * Returns 'lead', 'onboarding', 'active', or 'full'.
 */
export async function getPortalTier(accountId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('portal_tier')
    .eq('id', accountId)
    .single()

  return data?.portal_tier || 'active'
}

/**
 * Get portal tier from CONTACT (source of truth).
 * contacts.portal_tier tracks the person's journey, not the company's.
 * Falls back to 'lead' if not set.
 */
export async function getPortalTierByContact(contactId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('portal_tier')
    .eq('id', contactId)
    .single()

  return data?.portal_tier || 'lead'
}

/**
 * Nav visibility for contacts WITHOUT any account (e.g., ITIN-only clients).
 * Only contact-level features are visible.
 */
export function getContactOnlyNavVisibility(): PortalNavVisibility {
  return {
    services: true,
    billing: false,
    invoices: false,
    taxDocuments: false,
    deadlines: false,
    documents: true,
    customers: false,
    pendingSignatures: false,
  }
}

export async function getPortalTaxReturns(accountId: string) {
  // Tax returns are matched by company_name, not account_id
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', accountId)
    .single()

  if (!account?.company_name) return []

  const { data } = await supabaseAdmin
    .from('tax_returns')
    .select('id, tax_year, return_type, status, deadline, extension_filed, extension_deadline')
    .eq('company_name', account.company_name)
    .order('tax_year', { ascending: false })
    .limit(5)

  return data ?? []
}
