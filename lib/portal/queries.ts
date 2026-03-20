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

export async function getPortalDeadlines(accountId: string) {
  const today = new Date().toISOString().split('T')[0]
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
