import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/profile — Update client's contact info.
 *
 * Accepts the 5 structured address fields (address_line1 / address_city /
 * address_state / address_zip / address_country). Also dual-writes the
 * legacy `residency` column as a comma-concatenation so downstream readers
 * (OA generation, tax-form prefill, banking-form) keep working unchanged.
 *
 * Used by:
 *   - /portal/profile ProfileEditor (full profile edit)
 *   - ProfileCompletionBanner on portal home (partial fill-in of null fields)
 *
 * Auth: the JWT's contact_id (via getClientContactId) MUST match the
 * body's contact_id. Cross-tenant writes are rejected with 403.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sessionContactId = getClientContactId(user)
  if (!sessionContactId) return NextResponse.json({ error: 'No contact linked' }, { status: 400 })

  const body = await request.json()
  const {
    contact_id,
    first_name,
    last_name,
    phone,
    language,
    citizenship,
    date_of_birth,
    address_line1,
    address_city,
    address_state,
    address_zip,
    address_country,
    // Legacy — accepted for a brief transition so any old client code that
    // still sends `residency` doesn't error. Will be overwritten below by
    // the concat of the 5 fields when any of those are provided.
    residency,
  } = body

  if (contact_id !== sessionContactId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const updates: Record<string, unknown> = {}
  if (first_name !== undefined) updates.first_name = first_name
  if (last_name !== undefined) updates.last_name = last_name
  if (first_name !== undefined || last_name !== undefined) {
    // Keep full_name in sync — fetch the other half if only one side was sent
    const { data: current } = await supabaseAdmin
      .from('contacts')
      .select('first_name, last_name')
      .eq('id', sessionContactId)
      .single()
    const fn = first_name !== undefined ? first_name : (current?.first_name ?? '')
    const ln = last_name !== undefined ? last_name : (current?.last_name ?? '')
    updates.full_name = [fn, ln].filter(Boolean).join(' ')
  }
  if (phone !== undefined) updates.phone = phone
  if (language !== undefined) updates.language = language
  if (citizenship !== undefined) updates.citizenship = citizenship
  if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth
  if (address_line1 !== undefined) updates.address_line1 = address_line1
  if (address_city !== undefined) updates.address_city = address_city
  if (address_state !== undefined) updates.address_state = address_state
  if (address_zip !== undefined) updates.address_zip = address_zip
  if (address_country !== undefined) updates.address_country = address_country

  // Dual-write residency = concat(5 fields) when any address field was
  // sent — keeps legacy readers consistent. If the caller didn't send any
  // address field but DID send a raw residency string, honor it as-is.
  const anyAddressSent =
    address_line1 !== undefined ||
    address_city !== undefined ||
    address_state !== undefined ||
    address_zip !== undefined ||
    address_country !== undefined
  if (anyAddressSent) {
    // Fetch current values so a partial save still produces a correct concat.
    const { data: current } = await supabaseAdmin
      .from('contacts')
      .select('address_line1, address_city, address_state, address_zip, address_country')
      .eq('id', sessionContactId)
      .single()
    const resolved = {
      line1: address_line1 !== undefined ? address_line1 : current?.address_line1,
      city: address_city !== undefined ? address_city : current?.address_city,
      state: address_state !== undefined ? address_state : current?.address_state,
      zip: address_zip !== undefined ? address_zip : current?.address_zip,
      country: address_country !== undefined ? address_country : current?.address_country,
    }
    const parts = [resolved.line1, resolved.city, resolved.state, resolved.zip, resolved.country]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map(s => s.trim())
    if (parts.length > 0) updates.residency = parts.join(', ')
  } else if (residency !== undefined) {
    updates.residency = residency
  }

  updates.updated_at = new Date().toISOString()

  // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
  const { error } = await supabaseAdmin
    .from('contacts')
    .update(updates)
    .eq('id', sessionContactId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
