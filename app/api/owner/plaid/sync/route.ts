import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { syncPlaidTransactions } from '@/lib/plaid-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Owner-only, on-demand sync for My Finances' own bank connections (owner_scoped: true) —
// the same underlying syncPlaidTransactions the 6-hourly cron and Finance's "Sync All Banks
// Now" already use, scoped to only the connections made through this page. Does not touch
// Revolut/Relay/Mercury — those are Finance's concern and already covered by the existing
// cron and admin sync action.
type PlaidConnectionResult = { bank: string; added: number; modified: number } | { bank: string; error: string }

export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // `as never`: owner_scoped isn't in the generated types yet — see accounts/route.ts's sibling comment.
  const { data: connectionsRaw, error: readErr } = await supabaseAdmin
    .from('plaid_connections' as never)
    .select('id, access_token, bank_name')
    .eq('status', 'active')
    .eq('owner_scoped', true)

  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 })
  }
  const connections = (connectionsRaw ?? []) as unknown as { id: string; access_token: string; bank_name: string }[]
  if (connections.length === 0) {
    return NextResponse.json({ ok: true, connections: 0, results: [] })
  }

  const results: PlaidConnectionResult[] = []
  for (const conn of connections) {
    try {
      const r = await syncPlaidTransactions(conn.access_token, conn.bank_name)
      results.push({ bank: conn.bank_name, added: r.added, modified: r.modified })
    } catch (err) {
      results.push({ bank: conn.bank_name, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return NextResponse.json({ ok: true, connections: connections.length, results })
}
