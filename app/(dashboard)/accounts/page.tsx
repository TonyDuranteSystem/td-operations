import { createClient } from '@/lib/supabase/server'
import { AccountTable } from '@/components/accounts/account-table'
import type { AccountListItem } from '@/lib/types'
import type { PersonCardSource } from '@/lib/crm-lists/hover-cards'
import type { MailingAddressRow } from '@/lib/addresses'
import { accountFacetCounts, companyMatches, parseAccountFilters } from '@/lib/crm-lists/filters'
import { fetchAllRows, loadInstallmentChips, loadInstallmentYears, loadOverdueCounts, newYorkToday, newYorkYear } from '@/lib/crm-lists/queries'
import { letterCounts, letterMatches, parseLetter } from '@/lib/crm-lists/letters'
import { listYearOptions, parseListYear } from '@/lib/crm-lists/year'
import { getColumnPref } from '@/lib/crm-lists/prefs'
import { resolveColumns } from '@/lib/crm-lists/columns'
import { accountExtras } from '@/lib/crm-lists/extras'
import { companiesByPerson, currentMemberCounts, pickMainContacts, type AccountContactLink, type PersonCompanyRow } from '@/lib/crm-lists/people'
import { formatListDate } from '@/lib/crm-lists/format'
import { accountMatchesSearch } from '@/lib/crm-lists/search-match'
import { loadContractMismatchesForCompanies } from '@/lib/signed-contracts/load'

const PAGE_SIZE = 50

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; kind?: string; type?: string; overdue?: string; letter?: string; year?: string; page?: string }
}) {
  const supabase = createClient()
  const query = searchParams.q?.trim() ?? ''
  const filters = parseAccountFilters(searchParams)
  const letter = parseLetter(searchParams.letter)
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)

  // This person's chosen fields, and the years that have installment invoices.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const [saved, yearsWithInvoices] = await Promise.all([user ? getColumnPref(user.id, 'accounts') : Promise.resolve(null), loadInstallmentYears(supabase)])
  const columns = resolveColumns('accounts', saved)
  const defaultYear = newYorkYear()
  const years = listYearOptions(yearsWithInvoices, defaultYear)
  const year = parseListYear(searchParams.year, years, defaultYear)

  // Which companies have an overdue invoice: the "with overdue payments" pill is a filter like the others, so it is known up front.
  const overdueMap = await loadOverdueCounts(supabase)

  // Every company that matches the search, with just the words the filters use. The filters, the counts on each choice and the
  // header all work off this one list, so they always agree (the old header counted only the 50 on the page).
  const everyCompany = await fetchAllRows((from, to) =>
    supabase
      .from('accounts')
      .select('id, company_name, status, account_type, entity_type')
      .order('company_name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  // The search matches the same things the search dropdown shows: a company's name, or the name of one of its people. The people are
  // only read when something is typed.
  const personNamesByCompany = new Map<string, string[]>()
  if (query) {
    const peopleLinks = await fetchAllRows((from, to) =>
      supabase.from('account_contacts').select('account_id, contact_id, contact:contacts(full_name)').order('account_id', { ascending: true }).order('contact_id', { ascending: true }).range(from, to),
    )
    for (const l of peopleLinks as unknown as { account_id: string; contact: { full_name: string | null } | null }[]) {
      const name = l.contact?.full_name
      if (!name) continue
      const list = personNamesByCompany.get(l.account_id) ?? []
      list.push(name)
      personNamesByCompany.set(l.account_id, list)
    }
  }
  const baseRows = query ? everyCompany.filter(a => accountMatchesSearch(query, a, personNamesByCompany.get(a.id) ?? [])) : everyCompany
  const base = baseRows.map(a => ({ ...a, overdue_count: overdueMap[a.id] ?? 0 }))

  // The letter is one more filter: the choices' counts follow it, and the letter buttons' own counts follow the other filters.
  const baseForLetter = base.filter(a => letterMatches(a.company_name, letter))
  const facets = accountFacetCounts(baseForLetter, filters)
  const letters = letterCounts(base.filter(a => companyMatches(a, filters)).map(a => a.company_name))
  const filtered = baseForLetter.filter(a => companyMatches(a, filters))
  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const accountIds = pageRows.map(a => a.id)
  // The companies whose signed contract does not match their own installment amounts get the amber flag (dev job a2a663cf). The same rule
  // as the Contact page and the Contacts list; only the offers filed on THESE companies are read.
  const contractMismatches = await loadContractMismatchesForCompanies({
    accountIds,
    companyNames: new Map(pageRows.map(a => [a.id, a.company_name])),
  })

  type Detail = {
    state_of_formation: string | null
    installment_1_amount: number | null
    installment_1_currency: string | null
    installment_2_amount: number | null
    installment_2_currency: string | null
    updated_at: string
    client_since: string | null
    extras: Record<string, string | null>
  }
  const detailById: Record<string, Detail> = {}
  const contactMap: ReturnType<typeof pickMainContacts> = {}
  // The hover card of each company's main contact: their details and their companies.
  const contactCards: Record<string, PersonCardSource> = {}
  let chipMap: Awaited<ReturnType<typeof loadInstallmentChips>> = {}

  if (accountIds.length > 0) {
    const [{ data: details }, { data: links }, chips] = await Promise.all([
      supabase
        .from('accounts')
        // One literal string on purpose: the typed query builder only understands a select written as a single literal.
        // prettier-ignore
        .select('id, state_of_formation, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency, updated_at, formation_date, client_since, onboarding_date, member_count, ein_number, suite_number, physical_address, registered_agent_provider, ra_renewal_date, annual_report_due_date, lead_source, referrer, portal_tier, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip), registered_agent:addresses!registered_agent_id(provider)')
        .in('id', accountIds),
      supabase
        .from('account_contacts')
        .select('account_id, is_primary, ended_at, contact:contacts(id, full_name, email, phone, language, portal_tier)')
        .in('account_id', accountIds),
      loadInstallmentChips(supabase, accountIds, year),
    ])
    // "Number of members" counts the company's real current member rows (the free-text count on the account disagrees with them for some
    // companies); only read when that field is chosen.
    let memberCounts: Record<string, number> = {}
    if (columns.includes('member_count')) {
      const { data: memberRows } = await supabase.from('members').select('account_id, end_date').in('account_id', accountIds)
      memberCounts = currentMemberCounts(memberRows ?? [], newYorkToday())
    }
    for (const d of details ?? []) {
      detailById[d.id] = {
        state_of_formation: d.state_of_formation,
        installment_1_amount: d.installment_1_amount,
        installment_1_currency: d.installment_1_currency,
        installment_2_amount: d.installment_2_amount,
        installment_2_currency: d.installment_2_currency,
        updated_at: d.updated_at ?? '',
        client_since: d.client_since,
        // Only the chosen extra fields are turned into text, so nothing nobody asked for (the EIN) reaches the screen.
        extras: accountExtras(columns, {
          formation_date: d.formation_date,
          client_since: d.client_since,
          onboarding_date: d.onboarding_date,
          member_count: memberCounts[d.id] ?? d.member_count,
          ein_number: d.ein_number,
          suite_number: d.suite_number,
          physical_address: d.physical_address,
          mailing_address: d.mailing_address as unknown as MailingAddressRow | null,
          // A company whose agent was set with the picker has only the linked row; the free text is the old way.
          registered_agent_provider: (d.registered_agent as unknown as { provider: string | null } | null)?.provider ?? d.registered_agent_provider,
          ra_renewal_date: d.ra_renewal_date,
          annual_report_due_date: d.annual_report_due_date,
          lead_source: d.lead_source,
          referrer: d.referrer,
          portal_tier: d.portal_tier,
        }),
      }
    }
    Object.assign(contactMap, pickMainContacts((links ?? []) as unknown as AccountContactLink[]))
    chipMap = chips

    // Each main contact's own companies (the same links the Contacts list shows), for the contact's hover card.
    const mainIds = Array.from(new Set(Object.values(contactMap).map(c => c.id).filter((x): x is string => !!x)))
    if (mainIds.length > 0) {
      const { data: theirCompanies } = await supabase
        .from('account_contacts')
        .select('contact_id, account:accounts(company_name, status)')
        .in('contact_id', mainIds)
      const byPerson = companiesByPerson((theirCompanies ?? []) as unknown as PersonCompanyRow[])
      for (const c of Object.values(contactMap)) {
        if (!c.id || contactCards[c.id]) continue
        contactCards[c.id] = {
          full_name: c.name,
          email: c.email,
          phone: c.phone,
          language: c.language,
          portal_tier: c.portal_tier,
          companies: byPerson[c.id] ?? [],
        }
      }
    }
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
      client_since: formatListDate(d?.client_since),
      contact_card: contactMap[a.id]?.id ? (contactCards[contactMap[a.id].id as string] ?? null) : null,
      contract_mismatches: contractMismatches.kind === 'ok' ? (contractMismatches.byCompany.get(a.id) ?? []) : [],
      extras: d?.extras ?? {},
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
        {contractMismatches.kind === 'failed' && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="contract-check-failed">
            Could not check the contract amounts just now, so no company is marked. Reload the page to try again.
          </p>
        )}
      </div>
      <AccountTable
        items={items}
        query={query}
        statusFilter={filters.status}
        kindFilter={filters.kind}
        typeFilter={filters.type}
        overdueOnly={!!filters.overdue}
        facets={facets}
        stats={stats}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount}
        columns={columns}
        letter={letter}
        letters={letters}
        year={year}
        years={years}
        defaultYear={defaultYear}
      />
    </div>
  )
}
