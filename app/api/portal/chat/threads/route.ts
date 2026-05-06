import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * GET /api/portal/chat/threads — Admin only.
 * Returns one thread per contact (unified view). Each thread includes all
 * linked companies so the admin sees messages across all companies (e.g.
 * Aces + Stepwell) in a single conversation. Uses get_portal_chat_threads_unified() RPC.
 *
 * Response shape per thread:
 *   { account_id: null, contact_id, company_name (=contact_name for backward compat),
 *     contact_name, companies: [{id, name}], last_message, last_message_at, unread_count }
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (supabaseAdmin as any).rpc('get_portal_chat_threads_unified')

  if (!error && rows) {
    const threads = (rows as Array<{
      contact_id: string
      contact_name: string
      companies: { id: string; name: string }[]
      last_message: string
      last_message_at: string
      unread_count: number
    }>).map(r => ({
      account_id: null as string | null,
      contact_id: r.contact_id,
      company_name: r.contact_name,
      contact_name: r.contact_name,
      companies: r.companies ?? [],
      last_message: r.last_message ?? '',
      last_message_at: r.last_message_at ?? '',
      unread_count: Number(r.unread_count ?? 0),
    }))

    return NextResponse.json(threads)
  }

  return NextResponse.json([])
}
