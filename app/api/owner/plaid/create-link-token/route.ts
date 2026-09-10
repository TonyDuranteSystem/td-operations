import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { plaidClient, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from '@/lib/plaid'
import { isOwnerOnly } from '@/lib/auth'
import { INTERNAL_BASE_URL } from '@/lib/config'
import { CountryCode, Products } from 'plaid'

// Owner-only counterpart of /api/plaid/create-link-token. A genuinely separate route (not a
// shared one gated by an OR-condition) so My Finances' bank connections never depend on the
// same admin-level check the staff-facing Finance page uses.
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: 'td-owner' },
    client_name: 'Tony Durante LLC — My Finances',
    products: PLAID_PRODUCTS as unknown as Products[],
    country_codes: PLAID_COUNTRY_CODES as unknown as CountryCode[],
    language: 'en',
    webhook: `${INTERNAL_BASE_URL}/api/plaid/webhook`,
  })

  return NextResponse.json({ link_token: response.data.link_token })
}
