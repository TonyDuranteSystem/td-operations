import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

interface SearchResult {
  id: string
  title: string
  subtitle?: string
  type: 'account' | 'task' | 'lead' | 'contact'
  href: string
}

/**
 * GET /api/search?q=term&tables=accounts,tasks
 * Unified search across CRM tables. Promise.allSettled for parallel queries.
 * Pre-Coding Decision #9: only includes tables with existing pages.
 * Protected by auth middleware (not in exemption list).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''
  const tablesParam = searchParams.get('tables') ?? 'accounts,tasks'

  if (q.length < 2) {
    return NextResponse.json({ results: [] })
  }

  const allowedTables = tablesParam.split(',').filter(t => ['accounts', 'tasks', 'leads', 'contacts'].includes(t))
  const supabase = createClient()
  const pattern = `%${q}%`
  const limit = 5

  async function searchAccounts(): Promise<SearchResult[]> {
    const { data } = await supabase
      .from('accounts')
      .select('id, company_name, status, state_of_formation')
      .ilike('company_name', pattern)
      .limit(limit)
    return (data ?? []).map(a => ({
      id: a.id,
      title: a.company_name,
      subtitle: [a.status, a.state_of_formation].filter(Boolean).join(' \u2022 '),
      type: 'account' as const,
      href: `/accounts/${a.id}`,
    }))
  }

  async function searchTasks(): Promise<SearchResult[]> {
    const { data } = await supabase
      .from('tasks')
      .select('id, task_title, status, priority, assigned_to')
      .ilike('task_title', pattern)
      .in('status', ['To Do', 'In Progress', 'Waiting'])
      .limit(limit)
    return (data ?? []).map(t => ({
      id: t.id,
      title: t.task_title,
      subtitle: [t.priority, t.assigned_to, t.status].filter(Boolean).join(' \u2022 '),
      type: 'task' as const,
      href: '/tasks',
    }))
  }

  async function searchLeads(): Promise<SearchResult[]> {
    const { data } = await supabase
      .from('leads')
      .select('id, full_name, status, source')
      .ilike('full_name', pattern)
      .limit(limit)
    return (data ?? []).map(l => ({
      id: l.id,
      title: l.full_name,
      subtitle: [l.status, l.source].filter(Boolean).join(' \u2022 '),
      type: 'lead' as const,
      href: '/leads',
    }))
  }

  async function searchContacts(): Promise<SearchResult[]> {
    const { data } = await supabase
      .from('contacts')
      .select('id, full_name, email, phone')
      .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
      .limit(limit)
    return (data ?? []).map(c => ({
      id: c.id,
      title: c.full_name,
      subtitle: c.email ?? c.phone ?? '',
      type: 'contact' as const,
      href: '/accounts',
    }))
  }

  const queryMap: Record<string, () => Promise<SearchResult[]>> = {
    accounts: searchAccounts,
    tasks: searchTasks,
    leads: searchLeads,
    contacts: searchContacts,
  }

  const queries = allowedTables.map(t => queryMap[t]())
  const settled = await Promise.allSettled(queries)
  const results = settled
    .filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  return NextResponse.json({ results })
}
