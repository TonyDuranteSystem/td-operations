import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import type { EnhancedSearchResult } from '@/lib/types'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/search?q=term&tables=accounts,tasks,leads,contacts,chats
 * Unified search across CRM tables with rich preview data.
 * Accounts found by company name OR linked contact name.
 * Contacts found by name/email OR linked company name.
 * Chats found by company name or contact name (portal_messages threads).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''
  const tablesParam = searchParams.get('tables') ?? 'accounts,tasks,leads,contacts,chats'

  if (q.length < 2) {
    return NextResponse.json({ results: [] })
  }

  const allowedTables = tablesParam.split(',').filter(t =>
    ['accounts', 'tasks', 'leads', 'contacts', 'chats'].includes(t)
  )
  const supabase = createClient()
  const pattern = `%${q}%`
  const limit = 8

  function mapAccount(a: any): EnhancedSearchResult {
    const contacts = (a.account_contacts ?? []).slice(0, 5).map((ac: any) => ({
      name: ac.contacts?.full_name ?? '',
      email: ac.contacts?.email ?? null,
      phone: ac.contacts?.phone ?? null,
      role: ac.role ?? null,
    }))
    return {
      id: a.id,
      title: a.company_name,
      subtitle: [a.status, a.state_of_formation].filter(Boolean).join(' \u00b7 '),
      type: 'account' as const,
      href: `/accounts/${a.id}`,
      preview: {
        ein: a.ein_number ?? 'Not assigned yet',
        state: a.state_of_formation,
        entity_type: a.entity_type,
        status: a.status,
        formation_date: a.formation_date,
        contacts,
      },
    }
  }

  async function searchAccounts(): Promise<EnhancedSearchResult[]> {
    const selectFields = 'id, company_name, status, state_of_formation, entity_type, ein_number, formation_date, account_contacts(role, contacts(full_name, email, phone))'

    // 1) Direct match on company name
    const { data: byCompany } = await supabase
      .from('accounts')
      .select(selectFields)
      .ilike('company_name', pattern)
      .limit(limit)

    // 2) Reverse lookup: find accounts via linked contact names
    const { data: byContact } = await supabase
      .from('contacts')
      .select('account_contacts(accounts(' + selectFields + '))')
      .ilike('full_name', pattern)
      .limit(5)

    const seenIds = new Set<string>()
    const results: EnhancedSearchResult[] = []

    for (const a of (byCompany ?? [])) {
      seenIds.add(a.id)
      results.push(mapAccount(a))
    }

    // Add accounts found via contact name
    for (const c of (byContact ?? [])) {
      for (const ac of ((c as any).account_contacts ?? [])) {
        const acct = (ac as any).accounts
        if (!acct || seenIds.has(acct.id)) continue
        seenIds.add(acct.id)
        results.push(mapAccount(acct))
      }
    }

    return results.slice(0, limit)
  }

  async function searchTasks(): Promise<EnhancedSearchResult[]> {
    const { data } = await supabase
      .from('tasks')
      .select('id, task_title, status, priority, assigned_to, description')
      .ilike('task_title', pattern)
      .in('status', ['To Do', 'In Progress', 'Waiting'])
      .limit(limit)
    return (data ?? []).map((t: any) => ({
      id: t.id,
      title: t.task_title,
      subtitle: [t.priority, t.assigned_to, t.status].filter(Boolean).join(' \u00b7 '),
      type: 'task' as const,
      href: '/tasks',
      preview: {
        priority: t.priority,
        assigned_to: t.assigned_to,
        status: t.status,
        description: t.description?.slice(0, 200) ?? null,
      },
    }))
  }

  async function searchLeads(): Promise<EnhancedSearchResult[]> {
    const { data } = await supabase
      .from('leads')
      .select('id, full_name, status, source, reason, channel')
      .ilike('full_name', pattern)
      .limit(limit)
    return (data ?? []).map((l: any) => ({
      id: l.id,
      title: l.full_name,
      subtitle: [l.status, l.source].filter(Boolean).join(' \u00b7 '),
      type: 'lead' as const,
      href: `/leads/${l.id}`,
      preview: {
        status: l.status,
        source: l.source,
        reason: l.reason,
        channel: l.channel,
      },
    }))
  }

  async function searchContacts(): Promise<EnhancedSearchResult[]> {
    // 1) Direct match on contact name or email
    const { data: directMatches } = await supabase
      .from('contacts')
      .select('id, full_name, email, phone, account_contacts(accounts(id, company_name))')
      .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
      .limit(limit)

    // 2) Reverse lookup: find contacts linked to accounts matching the search query
    const { data: accountMatches } = await supabase
      .from('accounts')
      .select('id, company_name, account_contacts(contacts(id, full_name, email, phone))')
      .ilike('company_name', pattern)
      .limit(5)

    const seenIds = new Set<string>()
    const results: EnhancedSearchResult[] = []

    for (const c of (directMatches ?? [])) {
      seenIds.add(c.id)
      const companies = ((c as any).account_contacts ?? []).slice(0, 3).map((ac: any) => ({
        name: ac.accounts?.company_name ?? '',
        id: ac.accounts?.id ?? '',
      }))
      results.push({
        id: c.id,
        title: c.full_name,
        subtitle: c.email ?? c.phone ?? '',
        type: 'contact',
        href: `/contacts/${c.id}`,
        preview: {
          email: c.email,
          phone: c.phone,
          companies,
        },
      })
    }

    // Add contacts found via company name (deduplicate)
    for (const acct of (accountMatches ?? [])) {
      for (const ac of ((acct as any).account_contacts ?? [])) {
        const contact = ac.contacts
        if (!contact || seenIds.has(contact.id)) continue
        seenIds.add(contact.id)
        results.push({
          id: contact.id,
          title: contact.full_name,
          subtitle: `${contact.email ?? ''} \u00b7 ${(acct as any).company_name}`,
          type: 'contact',
          href: `/contacts/${contact.id}`,
          preview: {
            email: contact.email,
            phone: contact.phone,
            companies: [{ name: (acct as any).company_name, id: (acct as any).id }],
          },
        })
      }
    }

    return results.slice(0, limit)
  }

  async function searchChats(): Promise<EnhancedSearchResult[]> {
    // Find accounts that have portal chat messages, matching by company name or contact name
    const { data: byCompany } = await supabase
      .from('accounts')
      .select('id, company_name, account_contacts(contacts(full_name))')
      .ilike('company_name', pattern)
      .limit(10)

    const { data: byContact } = await supabase
      .from('contacts')
      .select('full_name, account_contacts(accounts(id, company_name))')
      .ilike('full_name', pattern)
      .limit(10)

    // Collect all account IDs
    const accountMap = new Map<string, { company_name: string; contact_name: string | null }>()

    for (const a of (byCompany ?? [])) {
      const contactName = (a as any).account_contacts?.[0]?.contacts?.full_name ?? null
      accountMap.set(a.id, { company_name: a.company_name, contact_name: contactName })
    }

    for (const c of (byContact ?? [])) {
      for (const ac of ((c as any).account_contacts ?? [])) {
        const acct = ac.accounts
        if (!acct || accountMap.has(acct.id)) continue
        accountMap.set(acct.id, { company_name: acct.company_name, contact_name: c.full_name })
      }
    }

    if (accountMap.size === 0) return []

    // Check which accounts have portal messages
    const accountIds = Array.from(accountMap.keys())
    const { data: chatAccounts } = await supabase
      .from('portal_messages')
      .select('account_id')
      .in('account_id', accountIds)
      .limit(50)

    const hasChat = new Set((chatAccounts ?? []).map((m: any) => m.account_id))

    const results: EnhancedSearchResult[] = []
    accountMap.forEach((info, id) => {
      // Show all matching accounts — those with chats get "Open chat", others get "Start chat"
      results.push({
        id,
        title: info.company_name,
        subtitle: info.contact_name ? `Chat with ${info.contact_name}` : 'Portal Chat',
        type: 'chat',
        href: `/portal-chats?account=${id}`,
        preview: {
          status: hasChat.has(id) ? 'Active' : 'New',
          companies: [{ name: info.company_name, id }],
        },
      })
    })

    return results.slice(0, limit)
  }

  const queryMap: Record<string, () => Promise<EnhancedSearchResult[]>> = {
    accounts: searchAccounts,
    tasks: searchTasks,
    leads: searchLeads,
    contacts: searchContacts,
    chats: searchChats,
  }

  const queries = allowedTables.map(t => queryMap[t]())
  const settled = await Promise.allSettled(queries)
  const results = settled
    .filter((r): r is PromiseFulfilledResult<EnhancedSearchResult[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  return NextResponse.json({ results })
}
