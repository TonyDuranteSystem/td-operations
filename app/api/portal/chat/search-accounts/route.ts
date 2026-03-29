import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/chat/search-accounts?q=term
 * Search active CRM accounts with their primary contact for starting a new portal chat.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ accounts: [] })
  }

  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const pattern = `%${q}%`

  // Search accounts by company name
  const { data: byCompany } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, account_contacts(contacts(full_name))')
    .eq('status', 'Active')
    .ilike('company_name', pattern)
    .limit(10)

  // Search accounts via contact name
  const { data: byContact } = await supabaseAdmin
    .from('contacts')
    .select('full_name, account_contacts(accounts(id, company_name, status))')
    .ilike('full_name', pattern)
    .limit(10)

  const seenIds = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts: any[] = []

  // Add company name matches
  for (const a of (byCompany ?? [])) {
    seenIds.add(a.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contactName = ((a as any).account_contacts?.[0]?.contacts?.full_name) ?? null
    accounts.push({ id: a.id, company_name: a.company_name, contact_name: contactName })
  }

  // Add contact name matches (via linked accounts)
  for (const c of (byContact ?? [])) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const ac of ((c as any).account_contacts ?? [])) {
      const acct = ac.accounts
      if (!acct || acct.status !== 'Active' || seenIds.has(acct.id)) continue
      seenIds.add(acct.id)
      accounts.push({ id: acct.id, company_name: acct.company_name, contact_name: c.full_name })
    }
  }

  return NextResponse.json({ accounts: accounts.slice(0, 15) })
}
