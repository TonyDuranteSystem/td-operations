import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Owner-scoped connections (made through My Finances' own connect flow) are never listed
  // here — this route backs the staff-facing Finance page, and mixing them in would show
  // Antonio's personal bank connection's name and balance to any admin, including a
  // non-owner one. My Finances reads its own connections via /api/owner/plaid/accounts.
  // `as never`: owner_scoped isn't in the generated types until the next `gen:types` run
  // against a schema that has it — this codebase's existing pattern for a column/table not
  // yet generated (see lib/owner-statement-import.ts's accountFacts for the same shape).
  const { data, error } = await supabaseAdmin
    .from('plaid_connections' as never)
    .select('id, bank_name, institution_name, accounts, status, last_synced_at, created_at')
    .eq('status', 'active')
    .eq('owner_scoped', false)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ connections: data ?? [] })
}
