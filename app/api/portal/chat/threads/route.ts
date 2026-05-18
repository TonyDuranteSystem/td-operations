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

    // Per Master Rule A1, the CONTACT is the center of every workflow. A
    // portal-chat thread is a conversation with a person; the badges must show
    // work that touches that person — directly (A6: individual services like
    // ITIN on a contact with no account) AND via every company they own (A2,
    // resolved through account_contacts). This mirrors the contact-centric
    // aggregation already used by PT3 (contact.portal_tier = max across linked
    // accounts). Multi-contact-account threads (RPC's "account-level" branch)
    // continue to pool by account_id directly.

    const contactIds = Array.from(new Set(
      rawThreads.map(r => r.contact_id).filter((id): id is string => !!id)
    ))
    const directAccountIds = Array.from(new Set(
      rawThreads.map(r => r.account_id).filter((id): id is string => !!id)
    ))

    // Step 1: for every thread contact, resolve their linked accounts.
    const accountsByContact: Record<string, string[]> = {}
    if (contactIds.length > 0) {
      const { data: links } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id, account_id')
        .in('contact_id', contactIds)
      for (const link of links ?? []) {
        const cid = link.contact_id as string
        const aid = link.account_id as string
        if (!aid) continue
        if (!accountsByContact[cid]) accountsByContact[cid] = []
        accountsByContact[cid].push(aid)
      }
    }

    // Step 2: pool every account we may need SDs for (direct from RPC + linked
    // via contact). One query, one IN list.
    const indirectAccountIds = Object.values(accountsByContact).flat()
    const allAccountIds = Array.from(new Set([...directAccountIds, ...indirectAccountIds]))

    // Step 3: fetch active SDs once via OR (account_id IN ... OR contact_id IN ...).
    // PostgREST's .or() filter does the union server-side; cheaper than two queries.
    type SdRow = { id: string; account_id: string | null; contact_id: string | null; service_type: string; stage: string | null }
    const sdById: Record<string, SdRow> = {}
    const sdsByAccount: Record<string, SdRow[]> = {}
    const sdsByContact: Record<string, SdRow[]> = {}
    if (allAccountIds.length > 0 || contactIds.length > 0) {
      const orClauses: string[] = []
      if (allAccountIds.length > 0) orClauses.push(`account_id.in.(${allAccountIds.join(',')})`)
      if (contactIds.length > 0) orClauses.push(`contact_id.in.(${contactIds.join(',')})`)
      const { data: sdRows } = await supabaseAdmin
        .from('service_deliveries')
        .select('id, account_id, contact_id, service_type, stage')
        .or(orClauses.join(','))
        .not('status', 'in', '(completed,cancelled)')
      for (const raw of sdRows ?? []) {
        const sd = raw as SdRow
        sdById[sd.id] = sd
        if (sd.account_id) {
          if (!sdsByAccount[sd.account_id]) sdsByAccount[sd.account_id] = []
          sdsByAccount[sd.account_id].push(sd)
        }
        if (sd.contact_id) {
          if (!sdsByContact[sd.contact_id]) sdsByContact[sd.contact_id] = []
          sdsByContact[sd.contact_id].push(sd)
        }
      }
    }

    // Step 4: assemble per-thread active_services, deduped by SD id.
    const resolveActiveServices = (r: { contact_id: string | null; account_id: string | null }): { service_type: string; stage: string | null }[] => {
      const seen = new Set<string>()
      const out: SdRow[] = []
      const push = (sd?: SdRow) => {
        if (!sd || seen.has(sd.id)) return
        seen.add(sd.id)
        out.push(sd)
      }
      // Direct: SDs attached to the thread's contact_id.
      if (r.contact_id) for (const sd of sdsByContact[r.contact_id] ?? []) push(sd)
      // Indirect: SDs attached to any account the contact owns.
      if (r.contact_id) for (const aid of accountsByContact[r.contact_id] ?? []) {
        for (const sd of sdsByAccount[aid] ?? []) push(sd)
      }
      // Account-level threads: SDs on the thread's own account_id.
      if (r.account_id) for (const sd of sdsByAccount[r.account_id] ?? []) push(sd)
      return out.map(sd => ({ service_type: sd.service_type, stage: sd.stage }))
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
      active_services: resolveActiveServices(r),
    }))

    return NextResponse.json(threads)
  }

  return NextResponse.json([])
}
