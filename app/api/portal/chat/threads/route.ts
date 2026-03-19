import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * GET /api/portal/chat/threads — Admin only: list all portal chat threads
 * Returns one entry per account with last message and unread count
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  // Get distinct account_ids with messages
  const { data: threads } = await supabaseAdmin.rpc('get_portal_chat_threads')

  if (!threads) {
    // Fallback: manual query if RPC doesn't exist
    const { data: accountIds } = await supabaseAdmin
      .from('portal_messages')
      .select('account_id')
      .order('created_at', { ascending: false })

    if (!accountIds?.length) return NextResponse.json([])

    const uniqueAccountIds = Array.from(new Set(accountIds.map(r => r.account_id)))

    const result = []
    for (const accountId of uniqueAccountIds.slice(0, 50)) {
      // Get account name
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', accountId)
        .single()

      // Get last message
      const { data: lastMsg } = await supabaseAdmin
        .from('portal_messages')
        .select('message, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      // Get unread count (client messages not read by admin)
      const { count } = await supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('sender_type', 'client')
        .is('read_at', null)

      result.push({
        account_id: accountId,
        company_name: account?.company_name ?? 'Unknown',
        last_message: lastMsg?.message ?? '',
        last_message_at: lastMsg?.created_at ?? '',
        unread_count: count ?? 0,
      })
    }

    // Sort by last message time
    result.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))

    return NextResponse.json(result)
  }

  return NextResponse.json(threads)
}
