import { createClient } from '@/lib/supabase/server'
import { ContactsTable } from '@/components/contacts/contacts-table'
import type { ContactCompanyLine, ContactListItem } from '@/lib/types'
import { contactLinkCounts, contactMatches, parseContactFilters, type FilterableCompany } from '@/lib/crm-lists/filters'
import { fetchAllRows, loadInstallmentChips, loadInstallmentYears, newYorkYear } from '@/lib/crm-lists/queries'
import { letterCounts, letterMatches, parseLetter } from '@/lib/crm-lists/letters'
import { listYearOptions, parseListYear } from '@/lib/crm-lists/year'
import { getColumnPref } from '@/lib/crm-lists/prefs'
import { resolveColumns } from '@/lib/crm-lists/columns'

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

  // 1. Every person that matches the search, in name order.
  const people = await fetchAllRows((from, to) => {
    let q = supabase.from('contacts').select('id, full_name').order('full_name', { ascending: true }).order('id', { ascending: true }).range(from, to)
    if (statusFilter && statusFilter !== 'all') q = q.eq('status', statusFilter)
    if (query) q = q.or(`full_name.ilike.%${query}%,email.ilike.%${query}%`)
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

  const [contactDetails, accountDetails, chipMap] = await Promise.all([
    pageIds.length > 0
      ? supabase
          .from('contacts')
          .select('id, full_name, email, phone, language, citizenship, portal_tier, portal_role, status, itin_number, passport_on_file, created_at')
          .in('id', pageIds)
      : Promise.resolve({ data: [] }),
    pageAccountIds.length > 0
      ? supabase
          .from('accounts')
          .select('id, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency, setup_fee_amount, setup_fee_currency, updated_at')
          .in('id', pageAccountIds)
      : Promise.resolve({ data: [] }),
    loadInstallmentChips(supabase, pageAccountIds, year),
  ])
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
        itin_number: c.itin_number,
        passport_on_file: c.passport_on_file,
        portal_role: c.portal_role,
        account_count: lines.length,
        account_names: lines.map(l => l.company_name).join(', ') || null,
        created_at: c.created_at,
        companies: lines,
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
