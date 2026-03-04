import { createClient } from '@/lib/supabase/server'
import { AccountTable } from '@/components/accounts/account-table'
import type { AccountListItem } from '@/lib/types'

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; type?: string }
}) {
  const supabase = createClient()
  const query = searchParams.q?.trim() ?? ''
  const statusFilter = searchParams.status ?? 'Active'
  const typeFilter = searchParams.type ?? ''

  let dbQuery = supabase
    .from('accounts')
    .select('id, company_name, entity_type, status, state_of_formation, formation_date, client_health, created_at')
    .order('company_name', { ascending: true })

  if (statusFilter && statusFilter !== 'all') {
    dbQuery = dbQuery.eq('status', statusFilter)
  }
  if (typeFilter) {
    dbQuery = dbQuery.eq('entity_type', typeFilter)
  }
  if (query) {
    dbQuery = dbQuery.ilike('company_name', `%${query}%`)
  }

  const { data: accounts } = await dbQuery

  // Get primary contact for each account
  const accountIds = (accounts ?? []).map(a => a.id)
  let contactMap: Record<string, { name: string; email: string | null }> = {}
  if (accountIds.length > 0) {
    const { data: contacts } = await supabase
      .from('account_contacts')
      .select('account_id, contact:contacts(full_name, email)')
      .in('account_id', accountIds)

    if (contacts) {
      for (const c of contacts) {
        const contact = c.contact as unknown as { full_name: string; email: string | null } | null
        if (contact && !contactMap[c.account_id]) {
          contactMap[c.account_id] = { name: contact.full_name, email: contact.email }
        }
      }
    }
  }

  // Get overdue payment counts
  const today = new Date().toISOString().split('T')[0]
  let overdueMap: Record<string, number> = {}
  if (accountIds.length > 0) {
    const { data: overdue } = await supabase
      .from('payments')
      .select('account_id')
      .in('account_id', accountIds)
      .in('status', ['Due', 'Overdue', 'Partially Paid'])
      .lt('due_date', today)

    if (overdue) {
      for (const p of overdue) {
        overdueMap[p.account_id] = (overdueMap[p.account_id] ?? 0) + 1
      }
    }
  }

  // Get service counts
  let serviceMap: Record<string, number> = {}
  if (accountIds.length > 0) {
    const { data: services } = await supabase
      .from('services')
      .select('account_id')
      .in('account_id', accountIds)
      .in('status', ['Not Started', 'In Progress', 'Blocked'])

    if (services) {
      for (const s of services) {
        serviceMap[s.account_id!] = (serviceMap[s.account_id!] ?? 0) + 1
      }
    }
  }

  const items: AccountListItem[] = (accounts ?? []).map(a => ({
    id: a.id,
    company_name: a.company_name,
    entity_type: a.entity_type,
    status: a.status,
    state_of_formation: a.state_of_formation,
    formation_date: a.formation_date,
    client_health: a.client_health,
    contact_name: contactMap[a.id]?.name ?? null,
    contact_email: contactMap[a.id]?.email ?? null,
    service_count: serviceMap[a.id] ?? 0,
    payment_overdue: overdueMap[a.id] ?? 0,
  }))

  const stats = {
    total: items.length,
    smllc: items.filter(a => a.entity_type === 'Single Member LLC').length,
    mmllc: items.filter(a => a.entity_type === 'Multi Member LLC').length,
    corp: items.filter(a => a.entity_type === 'C-Corp Elected').length,
    withOverdue: items.filter(a => a.payment_overdue > 0).length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {stats.total} aziende — {stats.smllc} SMLLC, {stats.mmllc} MMLLC, {stats.corp} Corp
        </p>
      </div>
      <AccountTable
        items={items}
        query={query}
        statusFilter={statusFilter}
        typeFilter={typeFilter}
        stats={stats}
      />
    </div>
  )
}
