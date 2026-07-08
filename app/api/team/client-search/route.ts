import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/team/client-search?q=...
 * Search accounts + contacts + leads for the "New conversation" client picker.
 * Staff-only. Mirrors the Slack Client-Threads modal's 3-table search
 * (searchClientsForSlackOptions) but returns a generic web shape:
 *   { results: [{ value: "account:<uuid>", label, sublabel, kind }] }
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const q = (request.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ results: [] })
  const pattern = `%${q}%`

  const [accts, contacts, leads] = await Promise.all([
    supabaseAdmin.from('accounts').select('id, company_name').ilike('company_name', pattern).limit(8),
    supabaseAdmin.from('contacts').select('id, full_name').ilike('full_name', pattern).limit(8),
    supabaseAdmin.from('leads').select('id, full_name').ilike('full_name', pattern).limit(8),
  ])

  const results: { value: string; label: string; sublabel: string; kind: 'account' | 'contact' | 'lead' }[] = []
  for (const a of accts.data ?? []) {
    if (a.company_name) results.push({ value: `account:${a.id}`, label: a.company_name, sublabel: 'Company', kind: 'account' })
  }
  for (const c of contacts.data ?? []) {
    if (c.full_name) results.push({ value: `contact:${c.id}`, label: c.full_name, sublabel: 'Contact', kind: 'contact' })
  }
  for (const l of leads.data ?? []) {
    if (l.full_name) results.push({ value: `lead:${l.id}`, label: l.full_name, sublabel: 'Lead', kind: 'lead' })
  }

  return NextResponse.json({ results: results.slice(0, 24) })
}
