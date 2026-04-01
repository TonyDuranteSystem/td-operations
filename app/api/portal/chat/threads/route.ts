import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * GET /api/portal/chat/threads — Admin only: list all portal chat threads
 * Returns one entry per account (or per contact if no account) with last message and unread count.
 * Supports both account-based threads AND contact-only threads (leads without accounts).
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  // Try RPC first
  const { data: threads } = await supabaseAdmin.rpc('get_portal_chat_threads')
  if (threads) {
    return NextResponse.json(threads)
  }

  // Fallback: manual query
  const result: Array<{
    account_id: string | null
    contact_id: string | null
    company_name: string
    contact_name: string | null
    last_message: string
    last_message_at: string
    unread_count: number
  }> = []

  // ─── 1. Account-based threads ──────────────────────────
  const { data: accountRows } = await supabaseAdmin
    .from('portal_messages')
    .select('account_id')
    .not('account_id', 'is', null)
    .order('created_at', { ascending: false })

  if (accountRows?.length) {
    const uniqueAccountIds = Array.from(new Set(accountRows.map(r => r.account_id)))

    for (const accountId of uniqueAccountIds.slice(0, 50)) {
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', accountId)
        .single()

      const { data: contactLink } = await supabaseAdmin
        .from('account_contacts')
        .select('contacts(full_name)')
        .eq('account_id', accountId)
        .limit(1)
        .single()

      const { data: lastMsg } = await supabaseAdmin
        .from('portal_messages')
        .select('message, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      const { count } = await supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('sender_type', 'client')
        .is('read_at', null)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contactName = (contactLink?.contacts as any)?.full_name ?? null

      result.push({
        account_id: accountId,
        contact_id: null,
        company_name: account?.company_name ?? 'Unknown',
        contact_name: contactName,
        last_message: lastMsg?.message ?? '',
        last_message_at: lastMsg?.created_at ?? '',
        unread_count: count ?? 0,
      })
    }
  }

  // ─── 2. Contact-only threads (no account) ──────────────
  const { data: contactRows } = await supabaseAdmin
    .from('portal_messages')
    .select('contact_id')
    .is('account_id', null)
    .not('contact_id', 'is', null)
    .order('created_at', { ascending: false })

  if (contactRows?.length) {
    const uniqueContactIds = Array.from(new Set(contactRows.map(r => r.contact_id)))

    for (const contactId of uniqueContactIds.slice(0, 50)) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('full_name, email')
        .eq('id', contactId)
        .single()

      const { data: lastMsg } = await supabaseAdmin
        .from('portal_messages')
        .select('message, created_at')
        .eq('contact_id', contactId)
        .is('account_id', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      const { count } = await supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contactId)
        .is('account_id', null)
        .eq('sender_type', 'client')
        .is('read_at', null)

      result.push({
        account_id: null,
        contact_id: contactId,
        company_name: contact?.full_name ?? contact?.email ?? 'Unknown Contact',
        contact_name: contact?.full_name ?? null,
        last_message: lastMsg?.message ?? '',
        last_message_at: lastMsg?.created_at ?? '',
        unread_count: count ?? 0,
      })
    }
  }

  // Sort all threads by last message time
  result.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))

  return NextResponse.json(result)
}
