import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/accounts?q=search&limit=8
 * Searches accounts by company_name AND by contact first_name/last_name.
 * Always returns accounts (with contact match info when relevant).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') ?? ''
  const limit = Math.min(Number(searchParams.get('limit') ?? '10'), 25)

  const supabase = createClient()

  if (q.length < 2) {
    // No search — return first accounts alphabetically
    const { data } = await supabase
      .from('accounts')
      .select('id, company_name, status')
      .order('company_name')
      .limit(limit)

    return NextResponse.json({ accounts: data ?? [] })
  }

  // Search accounts by company name
  const { data: byCompany } = await supabase
    .from('accounts')
    .select('id, company_name, status')
    .ilike('company_name', `%${q}%`)
    .order('company_name')
    .limit(limit)

  // Search contacts by first_name or last_name, then get their accounts
  const { data: contactMatches } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, account_contacts(account_id)')
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
    .limit(10)

  // Collect account IDs from contact matches
  const contactAccountIds = new Set<string>()
  const contactNameMap: Record<string, string> = {} // accountId -> contact name
  for (const c of contactMatches ?? []) {
    const contactName = [c.first_name, c.last_name].filter(Boolean).join(' ')
    const links = c.account_contacts as Array<{ account_id: string }> | null
    if (links) {
      for (const link of links) {
        contactAccountIds.add(link.account_id)
        contactNameMap[link.account_id] = contactName
      }
    }
  }

  // Fetch those accounts (exclude ones already found by company name)
  const companyIds = new Set((byCompany ?? []).map(a => a.id))
  const extraIds = Array.from(contactAccountIds).filter(id => !companyIds.has(id))

  let byContact: Array<{ id: string; company_name: string; status: string | null }> = []
  if (extraIds.length > 0) {
    const { data } = await supabase
      .from('accounts')
      .select('id, company_name, status')
      .in('id', extraIds)
      .order('company_name')
      .limit(limit)
    byContact = data ?? []
  }

  // Merge results: company matches first, then contact matches
  const accounts = [
    ...(byCompany ?? []).map(a => ({
      ...a,
      contact_name: contactNameMap[a.id] || null,
    })),
    ...byContact.map(a => ({
      ...a,
      contact_name: contactNameMap[a.id] || null,
    })),
  ].slice(0, limit)

  return NextResponse.json({ accounts })
}
