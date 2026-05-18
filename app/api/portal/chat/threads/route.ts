import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * GET /api/portal/chat/threads — Admin only.
 * Returns unified threads via get_portal_chat_threads_unified() RPC.
 *
 * Two thread types:
 *   Contact-level: { account_id: null, contact_id, contact_name, companies: [{id,name}], members: [] }
 *   Account-level: { account_id, contact_id: null, contact_name (=company_name), companies: [], members: [{id,name}] }
 *
 * Account-level threads are emitted for multi-member LLCs (≥2 contacts with messages on same account).
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (supabaseAdmin as any).rpc('get_portal_chat_threads_v2')

  if (!error && rows) {
    const rawThreads = rows as Array<{
      contact_id: string | null
      contact_name: string
      account_id: string | null
      companies: { id: string; name: string }[]
      members: { id: string; name: string }[]
      last_message: string
      last_message_at: string
      unread_count: number
    }>

    // Collect all account_ids to batch-fetch active service deliveries.
    const accountIds = Array.from(new Set(
      rawThreads.map(r => r.account_id).filter((id): id is string => !!id)
    ))

    // Build a map of account_id -> active SDs (any status except completed/cancelled).
    const sdsByAccount: Record<string, { service_type: string; stage: string | null }[]> = {}
    if (accountIds.length > 0) {
      const { data: sdRows } = await supabaseAdmin
        .from('service_deliveries')
        .select('account_id, service_type, stage')
        .in('account_id', accountIds)
        .not('status', 'in', '(completed,cancelled)')
      for (const sd of sdRows ?? []) {
        const aid = sd.account_id as string
        if (!sdsByAccount[aid]) sdsByAccount[aid] = []
        sdsByAccount[aid].push({ service_type: sd.service_type as string, stage: (sd.stage as string | null) ?? null })
      }
    }

    const threads = rawThreads.map(r => ({
      account_id: r.account_id ?? null,
      contact_id: r.contact_id ?? null,
      company_name: r.contact_name,
      contact_name: r.contact_name,
      companies: r.companies ?? [],
      members: r.members ?? [],
      last_message: r.last_message ?? '',
      last_message_at: r.last_message_at ?? '',
      unread_count: Number(r.unread_count ?? 0),
      active_services: r.account_id ? (sdsByAccount[r.account_id] ?? []) : [],
    }))

    return NextResponse.json(threads)
  }

  return NextResponse.json([])
}
