import { createClient } from '@/lib/supabase/server'
import { ContactsTable } from '@/components/contacts/contacts-table'
import type { ContactListItem } from '@/lib/types'

const PAGE_SIZE = 50

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; page?: string }
}) {
  const supabase = createClient()
  const query = searchParams.q?.trim() ?? ''
  const statusFilter = searchParams.status ?? 'active'
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)

  let dbQuery = supabase
    .from('contacts')
    .select('id, full_name, email, phone, language, citizenship, portal_tier, status, itin_number, passport_on_file, created_at', { count: 'exact' })
    .order('full_name', { ascending: true })

  if (statusFilter && statusFilter !== 'all') {
    dbQuery = dbQuery.eq('status', statusFilter)
  }
  if (query) {
    dbQuery = dbQuery.or(`full_name.ilike.%${query}%,email.ilike.%${query}%`)
  }

  const from = (currentPage - 1) * PAGE_SIZE
  dbQuery = dbQuery.range(from, from + PAGE_SIZE - 1)

  const { data: contacts, count: totalCount } = await dbQuery
  const totalPages = Math.ceil((totalCount ?? 0) / PAGE_SIZE)

  // Get account links for each contact
  const contactIds = (contacts ?? []).map(c => c.id)
  const accountMap: Record<string, { count: number; names: string }> = {}
  if (contactIds.length > 0) {
    const { data: links } = await supabase
      .from('account_contacts')
      .select('contact_id, account:accounts(company_name)')
      .in('contact_id', contactIds)

    if (links) {
      for (const l of links) {
        const account = l.account as unknown as { company_name: string } | null
        if (!accountMap[l.contact_id]) {
          accountMap[l.contact_id] = { count: 0, names: '' }
        }
        accountMap[l.contact_id].count++
        if (account) {
          accountMap[l.contact_id].names = accountMap[l.contact_id].names
            ? `${accountMap[l.contact_id].names}, ${account.company_name}`
            : account.company_name
        }
      }
    }
  }

  const items: ContactListItem[] = (contacts ?? []).map(c => ({
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
    account_count: accountMap[c.id]?.count ?? 0,
    account_names: accountMap[c.id]?.names ?? null,
    created_at: c.created_at,
  }))

  const stats = {
    total: totalCount ?? 0,
    withAccounts: items.filter(c => c.account_count > 0).length,
    withItin: items.filter(c => c.itin_number).length,
    withPassport: items.filter(c => c.passport_on_file).length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {stats.total} contacts — {stats.withAccounts} with LLCs, {stats.withItin} with ITIN, {stats.withPassport} with passport
        </p>
      </div>
      <ContactsTable
        items={items}
        query={query}
        statusFilter={statusFilter}
        stats={stats}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount ?? 0}
      />
    </div>
  )
}
