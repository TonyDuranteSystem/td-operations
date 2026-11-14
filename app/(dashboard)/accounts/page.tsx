import { createClient } from '@/lib/supabase/server'
import { AccountTable } from '@/components/accounts/account-table'
import type { AccountListItem } from '@/lib/types'
import { accountFacetCounts, companyMatches, parseAccountFilters } from '@/lib/crm-lists/filters'
import { fetchAllRows, loadInstallmentChips, loadOverdueCounts, newYorkYear } from '@/lib/crm-lists/queries'

const PAGE_SIZE = 50

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; kind?: string; type?: string; page?: string }
}) {
  const supabase = createClient()
  const query = searchParams.q?.trim() ?? ''
  const filters = parseAccountFilters(searchParams)
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)

  // Every company that matches the search, with just the three filterable words. The filters, the counts on each choice and the
  // header all work off this one list, so they always agree (the old header counted only the 50 on the page).
  const base = await fetchAllRows((from, to) => {
    let q = supabase
      .from('accounts')
      .select('id, company_name, status, account_type, entity_type')
      .order('company_name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (query) q = q.ilike('company_name', `%${query}%`)
    return q
  })

  const facets = accountFacetCounts(base, filters)
  const filtered = base.filter(a => companyMatches(a, filters))
  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  const overdueMap = await loadOverdueCounts(supabase)

  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const accountIds = pageRows.map(a => a.id)

  const detailById: Record<string, {
    state_of_formation: string | null
    installment_1_amount: number | null
    installment_1_currency: string | null
    installment_2_amount: number | null
    installment_2_currency: string | null
    updated_at: string
  }> = {}
  const contactMap: Record<string, { name: string; email: string | null }> = {}
  let chipMap: Awaited<ReturnType<typeof loadInstallmentChips>> = {}

  if (accountIds.length > 0) {
    const [{ data: details }, { data: links }, chips] = await Promise.all([
      supabase
        .from('accounts')
        .select('id, state_of_formation, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency, updated_at')
        .in('id', accountIds),
      supabase
        .from('account_contacts')
        .select('account_id, contact:contacts(full_name, email)')
        .in('account_id', accountIds),
      loadInstallmentChips(supabase, accountIds, newYorkYear()),
    ])
    for (const d of details ?? []) {
      detailById[d.id] = {
        state_of_formation: d.state_of_formation,
        installment_1_amount: d.installment_1_amount,
        installment_1_currency: d.installment_1_currency,
        installment_2_amount: d.installment_2_amount,
        installment_2_currency: d.installment_2_currency,
        updated_at: d.updated_at ?? '',
      }
    }
    for (const c of links ?? []) {
      const contact = c.contact as unknown as { full_name: string; email: string | null } | null
      if (contact && !contactMap[c.account_id]) {
        contactMap[c.account_id] = { name: contact.full_name, email: contact.email }
      }
    }
    chipMap = chips
  }

  const items: AccountListItem[] = pageRows.map(a => {
    const d = detailById[a.id]
    return {
      id: a.id,
      company_name: a.company_name,
      entity_type: a.entity_type,
      account_type: a.account_type,
      status: a.status,
      state_of_formation: d?.state_of_formation ?? null,
      contact_name: contactMap[a.id]?.name ?? null,
      contact_email: contactMap[a.id]?.email ?? null,
      payment_overdue: overdueMap[a.id] ?? 0,
      installment_1_amount: d?.installment_1_amount ?? null,
      installment_1_currency: d?.installment_1_currency ?? null,
      installment_2_amount: d?.installment_2_amount ?? null,
      installment_2_currency: d?.installment_2_currency ?? null,
      updated_at: d?.updated_at ?? '',
      chip_1: chipMap[a.id]?.first ?? { kind: 'not_invoiced', count: 0 },
      chip_2: chipMap[a.id]?.second ?? { kind: 'not_invoiced', count: 0 },
    }
  })

  // Header numbers cover every company in the current view, not just this page.
  const stats = {
    total: totalCount,
    smllc: filtered.filter(a => a.entity_type === 'Single Member LLC').length,
    mmllc: filtered.filter(a => a.entity_type === 'Multi Member LLC').length,
    corp: filtered.filter(a => a.entity_type === 'C-Corp Elected').length,
    typeNotSet: filtered.filter(a => !a.entity_type).length,
    withOverdue: filtered.filter(a => (overdueMap[a.id] ?? 0) > 0).length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {stats.total} companies — {stats.smllc} SMLLC, {stats.mmllc} MMLLC, {stats.corp} Corp
          {stats.typeNotSet > 0 ? `, ${stats.typeNotSet} type not set` : ''}
        </p>
      </div>
      <AccountTable
        items={items}
        query={query}
        statusFilter={filters.status}
        kindFilter={filters.kind}
        typeFilter={filters.type}
        facets={facets}
        stats={stats}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount}
      />
    </div>
  )
}
