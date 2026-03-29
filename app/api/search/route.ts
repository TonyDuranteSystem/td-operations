import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import type { EnhancedSearchResult } from '@/lib/types'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/search?q=term&tables=accounts,tasks,leads,contacts
 * Unified search across CRM tables with rich preview data.
 * Contacts are also found via their linked company names.
 * Protected by auth middleware (not in exemption list).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''
  const tablesParam = searchParams.get('tables') ?? 'accounts,tasks,leads,contacts'

  if (q.length < 2) {
    return NextResponse.json({ results: [] })
  }

  const allowedTables = tablesParam.split(',').filter(t => ['accounts', 'tasks', 'leads', 'contacts'].includes(t))
  const supabase = createClient()
  const pattern = `%${q}%`
  const limit = 8

  async function searchAccounts(): Promise<EnhancedSearchResult[]> {
    const { data } = await supabase
      .from('accounts')
      .select('id, company_name, status, state_of_formation, entity_type, ein_number, formation_date, account_contacts(role, contacts(full_name, email, phone))')
      .ilike('company_name', pattern)
      .limit(limit)
    return (data ?? []).map((a: any) => {
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
    })
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
      href: '/leads',
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

    // Build results from direct matches
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
        href: companies[0]?.id ? `/accounts/${companies[0].id}` : '/accounts',
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
          href: `/accounts/${(acct as any).id}`,
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

  const queryMap: Record<string, () => Promise<EnhancedSearchResult[]>> = {
    accounts: searchAccounts,
    tasks: searchTasks,
    leads: searchLeads,
    contacts: searchContacts,
  }

  const queries = allowedTables.map(t => queryMap[t]())
  const settled = await Promise.allSettled(queries)
  const results = settled
    .filter((r): r is PromiseFulfilledResult<EnhancedSearchResult[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  return NextResponse.json({ results })
}
