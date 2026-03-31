import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { plaidClient, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from '@/lib/plaid'
import { isAdmin } from '@/lib/auth'
import { CountryCode, Products } from 'plaid'

export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: 'td-admin' },
    client_name: 'Tony Durante LLC',
    products: PLAID_PRODUCTS as unknown as Products[],
    country_codes: PLAID_COUNTRY_CODES as unknown as CountryCode[],
    language: 'en',
  })

  return NextResponse.json({ link_token: response.data.link_token })
}
