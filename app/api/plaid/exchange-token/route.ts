import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { plaidClient } from '@/lib/plaid'
import { isAdmin } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { CountryCode } from 'plaid'
import type { Json } from '@/lib/database.types'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { public_token, bank_name } = await req.json()

  if (!public_token || !bank_name) {
    return NextResponse.json({ error: 'Missing public_token or bank_name' }, { status: 400 })
  }

  // Exchange public token for access token
  const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token })
  const { access_token, item_id } = exchangeResponse.data

  // Get institution info
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

  // Get linked accounts
  const accountsResponse = await plaidClient.accountsGet({ access_token })
  const accounts = accountsResponse.data.accounts.map(a => ({
    account_id: a.account_id,
    name: a.name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
    balances: a.balances,
  }))

  // Store in DB (upsert by item_id)
  const { error } = await supabaseAdmin
    .from('plaid_connections')
    .upsert({
      item_id,
      access_token,
      institution_id: institutionId,
      institution_name: institutionName,
      bank_name,
      accounts: accounts as unknown as Json,
      status: 'active',
      last_synced_at: null,
    }, { onConflict: 'item_id' })

  if (error) {
    console.error('Error saving plaid connection:', error)
    return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
  }

  return NextResponse.json({ success: true, bank_name, accounts_count: accounts.length })
}
