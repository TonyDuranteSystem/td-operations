import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { plaidClient } from '@/lib/plaid'
import { isOwnerOnly } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { CountryCode } from 'plaid'
import type { Json } from '@/lib/database.types'

// Owner-only counterpart of /api/plaid/exchange-token. The one functional difference beyond
// the auth check: every row this route writes is stamped owner_scoped: true, so it never
// appears in the staff-facing Finance page's Connected Banks list (/api/plaid/accounts
// explicitly excludes owner_scoped rows).
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { public_token, bank_name, sync_from_date } = await req.json()

  if (!public_token || !bank_name) {
    return NextResponse.json({ error: 'Missing public_token or bank_name' }, { status: 400 })
  }
  // Optional. When set, syncPlaidTransactions never pulls anything on or before this date —
  // Antonio's own confirmation that "everything up to here is already in my books by hand."
  if (sync_from_date !== undefined && sync_from_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(sync_from_date)) {
    return NextResponse.json({ error: 'sync_from_date must be YYYY-MM-DD' }, { status: 400 })
  }

  const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token })
  const { access_token, item_id } = exchangeResponse.data

  const itemResponse = await plaidClient.itemGet({ access_token })
  const institutionId = itemResponse.data.item.institution_id

  let institutionName = bank_name
  if (institutionId) {
    const instResponse = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    })
    institutionName = instResponse.data.institution.name
  }

  const accountsResponse = await plaidClient.accountsGet({ access_token })
  const accounts = accountsResponse.data.accounts.map(a => ({
    account_id: a.account_id,
    name: a.name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
    balances: a.balances,
  }))

  // `as never`: owner_scoped isn't in the generated types yet — see accounts/route.ts's sibling comment.
  const { error } = await supabaseAdmin
    .from('plaid_connections' as never)
    .upsert({
      item_id,
      access_token,
      institution_id: institutionId,
      institution_name: institutionName,
      bank_name,
      accounts: accounts as unknown as Json,
      status: 'active',
      last_synced_at: null,
      owner_scoped: true,
      sync_from_date: sync_from_date ?? null,
    } as never, { onConflict: 'item_id' })

  if (error) {
    console.error('Error saving owner plaid connection:', error)
    return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
  }

  return NextResponse.json({ success: true, bank_name, accounts_count: accounts.length })
}
