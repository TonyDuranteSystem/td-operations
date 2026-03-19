import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/customers — Create a new customer with full details
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id, name, first_name, last_name, company_name, email, phone, address, city, region, country, vat_number, notes } = body

  if (!account_id) return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  if (!name && !first_name && !company_name) return NextResponse.json({ error: 'Name or company name required' }, { status: 400 })

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  const { data, error } = await supabaseAdmin
    .from('client_customers')
    .insert({
      account_id,
      name: name || `${first_name || ''} ${last_name || ''}`.trim() || company_name,
      first_name: first_name || null,
      last_name: last_name || null,
      company_name: company_name || null,
      email: email || null,
      phone: phone || null,
      address: address || null,
      city: city || null,
      region: region || null,
      country: country || null,
      vat_number: vat_number || null,
      notes: notes || null,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  revalidatePath('/portal/customers')
  return NextResponse.json({ success: true, id: data.id })
}
