import { createClient } from '@/lib/supabase/server'
import { ContactsTable } from '@/components/contacts/contacts-table'
import type { ContactCompanyLine, ContactListItem } from '@/lib/types'
import { contactLinkCounts, contactMatches, parseContactFilters, type FilterableCompany } from '@/lib/crm-lists/filters'
import { fetchAllRows, loadInstallmentChips, loadInstallmentYears, loadOverdueCounts, newYorkYear } from '@/lib/crm-lists/queries'
import { letterCounts, letterMatches, parseLetter } from '@/lib/crm-lists/letters'
import { listYearOptions, parseListYear } from '@/lib/crm-lists/year'
import { getColumnPref } from '@/lib/crm-lists/prefs'
import { resolveColumns } from '@/lib/crm-lists/columns'
import { formatListDate } from '@/lib/crm-lists/format'
import { contactMatchesSearch } from '@/lib/crm-lists/search-match'
import { contactsWithPassportFile, passportOnFile } from '@/lib/contacts/passport-on-file'
import { pickMainContacts, type AccountContactLink } from '@/lib/crm-lists/people'
import { loadContractMismatchesForPeople } from '@/lib/signed-contracts/load'

const PAGE_SIZE = 50

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; link?: string; cstatus?: string; kind?: string; ctype?: string; letter?: string; year?: string; page?: string }
}) {
  const supabase = createClient()
  const query = searchParams.q?.trim() ?? ''
  // Every contact is "active" today; the setting stays in the URL (old links keep working) but has no control on the page.
  const statusFilter = searchParams.status ?? 'active'
  const filters = parseContactFilters(searchParams)
  const letter = parseLetter(searchParams.letter)
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)

  // This person's chosen fields, and the years that have installment invoices.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const [saved, yearsWithInvoices] = await Promise.all([user ? getColumnPref(user.id, 'contacts') : Promise.resolve(null), loadInstallmentYears(supabase)])
  const columns = resolveColumns('contacts', saved)
  const defaultYear = newYorkYear()
  const years = listYearOptions(yearsWithInvoices, defaultYear)
  const year = parseListYear(searchParams.year, years, defaultYear)

  // 1. Every person, in name order (the search below is applied once we know their companies).
  const everyone = await fetchAllRows((from, to) => {
    let q = supabase.from('contacts').select('id, full_name, email, phone').order('full_name', { ascending: true }).order('id', { ascending: true }).range(from, to)
    if (statusFilter && statusFilter !== 'all') q = q.eq('status', statusFilter)
    return q
  })

  // 2. Which companies each person is linked to, with just the words the filters use.
  const [links, accounts] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase.from('account_contacts').select('contact_id, account_id').order('contact_id', { ascending: true }).order('account_id', { ascending: true }).range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase.from('accounts').select('id, company_name, status, account_type, entity_type').order('id', { ascending: true }).range(from, to),
    ),
  ])
  const accountById = new Map(accounts.map(a => [a.id, a]))
  const companiesByContact = new Map<string, { id: string; company_name: string; filter: FilterableCompany }[]>()
  for (const l of links) {
    const a = l.account_id ? accountById.get(l.account_id) : undefined
    if (!a) continue
    const list = companiesByContact.get(l.contact_id) ?? []
    if (!list.some(x => x.id === a.id)) {
      list.push({ id: a.id, company_name: a.company_name, filter: { status: a.status, account_type: a.account_type, entity_type: a.entity_type } })
    }
    companiesByContact.set(l.contact_id, list)
  }
  for (const list of Array.from(companiesByContact.values())) list.sort((x, y) => x.company_name.localeCompare(y.company_name))

  // The search matches the same things the search dropdown shows: a person's name, email or phone, or the name of one of their companies.
  const people = query ? everyone.filter(p => contactMatchesSearch(query, p, (companiesByContact.get(p.id) ?? []).map(c => c.company_name))) : everyone
  const withCompanies = people.map(p => ({ ...p, companies: companiesByContact.get(p.id) ?? [] }))
  // The letter is one more filter: the Companies counts follow it, and the letter buttons' own counts follow the other filters.
  const letterCountsForView = letterCounts(withCompanies.filter(p => contactMatches(p.companies.map(c => c.filter), filters)).map(p => p.full_name))
  const forLetter = withCompanies.filter(p => letterMatches(p.full_name, letter))
  const linkCounts = contactLinkCounts(forLetter.map(p => ({ companies: p.companies.map(c => c.filter) })), filters)
  const filtered = forLetter.filter(p => contactMatches(p.companies.map(c => c.filter), filters))
  const totalCount = filtered.length
  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  // 3. Full details for just the people on this page, and the money for their companies.
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const pageIds = pageRows.map(p => p.id)
  const pageAccountIds = Array.from(new Set(pageRows.flatMap(p => p.companies.map(c => c.id))))

  const [contactDetails, accountDetails, chipMap, mainLinks, overdueMap, passportFiles, contractMismatches] = await Promise.all([
    pageIds.length > 0
      ? supabase
          .from('contacts')
          .select('id, full_name, email, phone, language, citizenship, portal_tier, portal_role, status, itin_number, passport_on_file, created_at')
          .in('id', pageIds)
      : Promise.resolve({ data: [] }),
    pageAccountIds.length > 0
      ? supabase
          .from('accounts')
          .select('id, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency, setup_fee_amount, setup_fee_currency, updated_at, state_of_formation, client_since')
          .in('id', pageAccountIds)
      : Promise.resolve({ data: [] }),
    loadInstallmentChips(supabase, pageAccountIds, year),
    // Each company's main contact and its overdue count, for the company's hover card.
    pageAccountIds.length > 0
      ? supabase.from('account_contacts').select('account_id, is_primary, ended_at, contact:contacts(full_name, email)').in('account_id', pageAccountIds)
      : Promise.resolve({ data: [] }),
    loadOverdueCounts(supabase),
    contactsWithPassportFile(pageIds),
    // Whose signed contract does not match their company (the amber note on the Contact page), for the amber name + its hover card.
    loadContractMismatchesForPeople({
      people: pageRows.map(p => ({ id: p.id, email: p.email ?? null, accountIds: p.companies.map(c => c.id) })),
      companyNames: new Map(accounts.map(a => [a.id, a.company_name])),
    }),
  ])
  const mainContacts = pickMainContacts((mainLinks.data ?? []) as unknown as AccountContactLink[])
  const contactById = new Map((contactDetails.data ?? []).map(c => [c.id, c]))
  const moneyById = new Map((accountDetails.data ?? []).map(a => [a.id, a]))

  const items: ContactListItem[] = pageRows.flatMap(p => {
    const c = contactById.get(p.id)
    if (!c) return []
    const lines: ContactCompanyLine[] = p.companies.map(co => {
      const m = moneyById.get(co.id)
      return {
        account_id: co.id,
        company_name: co.company_name,
        entity_type: co.filter.entity_type,
        account_type: co.filter.account_type,
        status: co.filter.status,
        installment_1_amount: m?.installment_1_amount ?? null,
        installment_1_currency: m?.installment_1_currency ?? null,
        installment_2_amount: m?.installment_2_amount ?? null,
        installment_2_currency: m?.installment_2_currency ?? null,
        setup_fee_amount: m?.setup_fee_amount ?? null,
        setup_fee_currency: m?.setup_fee_currency ?? null,
        updated_at: m?.updated_at ?? '',
        chip_1: chipMap[co.id]?.first ?? { kind: 'not_invoiced', count: 0 },
        chip_2: chipMap[co.id]?.second ?? { kind: 'not_invoiced', count: 0 },
        state_of_formation: m?.state_of_formation ?? null,
        client_since: formatListDate(m?.client_since),
        contact_name: mainContacts[co.id]?.name ?? null,
        contact_email: mainContacts[co.id]?.email ?? null,
        payment_overdue: overdueMap[co.id] ?? 0,
      }
    })
    return [
      {
        id: c.id,
        full_name: c.full_name,
        email: c.email,
        phone: c.phone,
        language: c.language,
        citizenship: c.citizenship,
        portal_tier: c.portal_tier,
        status: c.status,
        itin_on_file: !!c.itin_number,
        passport_on_file: passportOnFile(c.passport_on_file, passportFiles.has(c.id)),
        portal_role: c.portal_role,
        account_count: lines.length,
        account_names: lines.map(l => l.company_name).join(', ') || null,
        created_at: c.created_at,
        companies: lines,
        contract_mismatches: contractMismatches.kind === 'ok' ? contractMismatches.byPerson.get(c.id) ?? [] : [],
      },
    ]
  })

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {linkCounts.all} contacts — {linkCounts.with} with a company, {linkCounts.none} with no company
        </p>
        {contractMismatches.kind === 'failed' && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="contract-check-failed">
            Could not check the contract amounts just now, so no contact is marked. Reload the page to try again.
          </p>
        )}
      </div>
      <ContactsTable
        items={items}
        query={query}
        statusFilter={statusFilter}
        filters={filters}
        linkCounts={linkCounts}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount}
        columns={columns}
        letter={letter}
        letters={letterCountsForView}
        year={year}
        years={years}
        defaultYear={defaultYear}
      />
    </div>
  )
}
