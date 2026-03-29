import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/inbox/contacts-search?q=term
 * Search contacts that have a phone number (for WhatsApp).
 * Also finds contacts via linked company names.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ contacts: [] })
  }

  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const pattern = `%${q}%`

  // 1) Direct match on contact name, email, or phone
  const { data: directMatches } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name, email, phone, account_contacts(accounts(id, company_name))')
    .not('phone', 'is', null)
    .or(`full_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`)
    .limit(10)

  // 2) Reverse lookup: contacts linked to matching accounts
  const { data: accountMatches } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, account_contacts(contacts(id, full_name, email, phone))')
    .ilike('company_name', pattern)
    .limit(5)

  const seenIds = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contacts: any[] = []

  // Add direct matches
  for (const c of (directMatches ?? [])) {
    seenIds.add(c.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const companies = ((c as any).account_contacts ?? []).map((ac: any) => ({
      name: ac.accounts?.company_name ?? '',
      id: ac.accounts?.id ?? '',
    }))
    contacts.push({
      id: c.id,
      full_name: c.full_name,
      email: c.email,
      phone: c.phone,
      companies,
    })
  }

  // Add contacts found via company name (with phone only)
  for (const acct of (accountMatches ?? [])) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const ac of ((acct as any).account_contacts ?? [])) {
      const contact = ac.contacts
      if (!contact || !contact.phone || seenIds.has(contact.id)) continue
      seenIds.add(contact.id)
      contacts.push({
        id: contact.id,
        full_name: contact.full_name,
        email: contact.email,
        phone: contact.phone,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        companies: [{ name: (acct as any).company_name, id: (acct as any).id }],
      })
    }
  }

  return NextResponse.json({ contacts: contacts.slice(0, 15) })
}
