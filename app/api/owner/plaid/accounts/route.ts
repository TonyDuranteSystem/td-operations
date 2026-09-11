import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

// Owner-only counterpart of /api/plaid/accounts — lists ONLY the connections Antonio made
// through My Finances (owner_scoped: true). The staff-facing Finance page's connections are a
// separate concern, managed there; this route never returns them.
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // `as never`: owner_scoped/sync_from_date aren't in the generated types yet — see
  // app/api/plaid/accounts/route.ts's sibling comment.
  const { data, error } = await supabaseAdmin
    .from('plaid_connections' as never)
    .select('id, bank_name, institution_name, accounts, status, last_synced_at, created_at, sync_from_date')
    .eq('status', 'active')
    .eq('owner_scoped', true)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ connections: data ?? [] })
}
