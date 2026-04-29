import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

// GET /api/clients/audit/[id]/contacts?q=term — search contacts to link
export async function GET(req: NextRequest, { params: _params }: { params: { id: string } }) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ contacts: [] })

  const pattern = `%${q}%`
  const { data } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name, email, phone, language, citizenship, itin, portal_tier, date_of_birth, passport_number, passport_expiry_date, passport_on_file, kyc_status, address_line1, address_city, address_state, address_zip, address_country')
    .or(`full_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`)
    .limit(10)

  return NextResponse.json({ contacts: data ?? [] })
}

// POST /api/clients/audit/[id]/contacts — link existing contact or create+link new one
/* eslint-disable no-restricted-syntax */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()

  // Link existing contact
  if (body.contact_id) {
    const { error } = await supabaseAdmin
      .from('account_contacts')
      .upsert({ account_id: params.id, contact_id: body.contact_id }, { onConflict: 'account_id,contact_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('id, full_name, email, phone, language, citizenship, itin, portal_tier, date_of_birth, passport_number, passport_expiry_date, passport_on_file, kyc_status, address_line1, address_city, address_state, address_zip, address_country')
      .eq('id', body.contact_id)
      .single()
    return NextResponse.json({ ok: true, contact })
  }

  // Create new contact and link
  if (body.full_name) {
    const { data: contact, error: createErr } = await supabaseAdmin
      .from('contacts')
      .insert({
        full_name: body.full_name,
        email: body.email ?? null,
        phone: body.phone ?? null,
        language: body.language ?? null,
        citizenship: body.citizenship ?? null,
      })
      .select('id, full_name, email, phone, language, citizenship, itin, portal_tier, date_of_birth, passport_number, passport_expiry_date, passport_on_file, kyc_status, address_line1, address_city, address_state, address_zip, address_country')
      .single()
    if (createErr) return NextResponse.json({ error: createErr.message }, { status: 500 })

    const { error: linkErr } = await supabaseAdmin
      .from('account_contacts')
      .insert({ account_id: params.id, contact_id: contact.id })
    if (linkErr) return NextResponse.json({ error: linkErr.message }, { status: 500 })

    await supabaseAdmin.from('action_log').insert({
      account_id: params.id,
      action_type: 'audit_contact_created',
      table_name: 'contacts',
      summary: `Audit: created and linked new contact ${contact.full_name}`,
    })

    return NextResponse.json({ ok: true, contact })
  }

  return NextResponse.json({ error: 'Provide contact_id or full_name' }, { status: 400 })
}
/* eslint-enable no-restricted-syntax */
