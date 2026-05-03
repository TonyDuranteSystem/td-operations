/**
 * GET /api/accounts/search-for-feed-match?q=<name>&limit=10
 *
 * Used by the Bank Feed UnmatchedRow → Match dialog. Returns accounts +
 * contacts (without linked accounts) so staff can attribute an incoming
 * payment to either the LLC or an individual person.
 *
 * Why a separate endpoint from /api/accounts: the existing endpoint only
 * returns accounts. Contacts that aren't linked to any account get dropped.
 * For bank-feed matching, individual payments (e.g. Mario Rossi paying as
 * a person) need a contact-only result so staff can create a contact-
 * scoped invoice without an account.
 *
 * Response shape:
 *   { results: Array<
 *       | { type: 'account', id, name, status, contact_name? }
 *       | { type: 'contact', id, name, email? }
 *     > }
 */
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

interface AccountResult {
  type: 'account'
  id: string
  name: string
  status: string | null
  contact_name?: string | null
}
interface ContactResult {
  type: 'contact'
  id: string
  name: string
  email?: string | null
}
type Result = AccountResult | ContactResult

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') ?? '').trim()
  const limit = Math.min(Number(searchParams.get('limit') ?? '10'), 25)

  if (q.length < 2) {
    return NextResponse.json({ results: [] })
  }

  // 1. Accounts by company_name
  const { data: byCompany } = await supabase
    .from('accounts')
    .select('id, company_name, status')
    .ilike('company_name', `%${q}%`)
    .order('company_name')
    .limit(limit)

  // 2. Contacts by full_name OR first/last name — get linked accounts so we can
  //    surface contact-only contacts (no linked account) separately.
  const { data: contactMatches } = await supabase
    .from('contacts')
    .select('id, full_name, first_name, last_name, email, account_contacts(account_id)')
    .or(`full_name.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
    .limit(limit * 2)

  type ContactRow = {
    id: string
    full_name: string | null
    first_name: string | null
    last_name: string | null
    email: string | null
    account_contacts: Array<{ account_id: string }> | null
  }

  const contactsTyped = (contactMatches ?? []) as unknown as ContactRow[]
  const contactDisplayName = (c: ContactRow): string =>
    c.full_name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '(unnamed)'

  // 3. Resolve account_ids reached via contact match (those NOT already in byCompany)
  const companyIds = new Set((byCompany ?? []).map(a => a.id))
  const contactAccountIds = new Set<string>()
  const contactNameByAccount: Record<string, string> = {}
  const unlinkedContacts: ContactRow[] = []

  for (const c of contactsTyped) {
    const links = c.account_contacts ?? []
    if (links.length === 0) {
      unlinkedContacts.push(c)
    } else {
      for (const link of links) {
        if (!companyIds.has(link.account_id)) {
          contactAccountIds.add(link.account_id)
          contactNameByAccount[link.account_id] = contactDisplayName(c)
        }
      }
    }
  }

  let byContactAccounts: Array<{ id: string; company_name: string; status: string | null }> = []
  if (contactAccountIds.size > 0) {
    const { data } = await supabase
      .from('accounts')
      .select('id, company_name, status')
      .in('id', Array.from(contactAccountIds))
      .order('company_name')
      .limit(limit)
    byContactAccounts = data ?? []
  }

  const accountResults: AccountResult[] = [
    ...(byCompany ?? []).map<AccountResult>(a => ({
      type: 'account',
      id: a.id,
      name: a.company_name,
      status: a.status,
      contact_name: null,
    })),
    ...byContactAccounts.map<AccountResult>(a => ({
      type: 'account',
      id: a.id,
      name: a.company_name,
      status: a.status,
      contact_name: contactNameByAccount[a.id] ?? null,
    })),
  ]

  const contactResults: ContactResult[] = unlinkedContacts.slice(0, limit).map(c => ({
    type: 'contact',
    id: c.id,
    name: contactDisplayName(c),
    email: c.email,
  }))

  const results: Result[] = [...accountResults, ...contactResults].slice(0, limit)
  return NextResponse.json({ results })
}
