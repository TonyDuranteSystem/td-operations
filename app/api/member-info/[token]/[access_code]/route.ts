import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

interface MemberPayload {
  member_type: 'individual' | 'company'
  full_name?: string
  company_name?: string
  ein?: string
  email?: string
  phone?: string
  ownership_pct?: string | number
  address_street?: string
  address_city?: string
  address_state?: string
  address_zip?: string
  address_country?: string
  representative_name?: string
  representative_email?: string
  representative_phone?: string
  representative_address_street?: string
  representative_address_city?: string
  representative_address_state?: string
  representative_address_zip?: string
  representative_address_country?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: { token: string; access_code: string } },
) {
  const { token, access_code } = params

  // 1. Validate request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: request, error: reqErr } = await (supabaseAdmin as any)
    .from('member_info_requests')
    .select('id, account_id, status')
    .eq('token', token)
    .eq('access_code', access_code)
    .single() as { data: { id: string; account_id: string; status: string } | null; error: unknown }

  if (reqErr || !request) {
    return NextResponse.json({ error: 'Invalid or expired link.' }, { status: 404 })
  }

  if (request.status === 'submitted') {
    return NextResponse.json({ error: 'This form has already been submitted.' }, { status: 409 })
  }

  // 2. Parse body
  const body = await req.json()
  const members: MemberPayload[] = body.members

  if (!Array.isArray(members) || members.length === 0) {
    return NextResponse.json({ error: 'At least one member is required.' }, { status: 400 })
  }

  // 3. Validate each member
  for (const m of members) {
    if (!m.member_type || !['individual', 'company'].includes(m.member_type)) {
      return NextResponse.json({ error: 'Each member must have a valid type (individual or company).' }, { status: 400 })
    }
    if (m.member_type === 'individual' && !m.full_name?.trim()) {
      return NextResponse.json({ error: 'Individual members must have a full name.' }, { status: 400 })
    }
    if (m.member_type === 'company' && !m.company_name?.trim()) {
      return NextResponse.json({ error: 'Company members must have a company name.' }, { status: 400 })
    }
    const pct = parseFloat(String(m.ownership_pct || 0))
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      return NextResponse.json({ error: 'Each member must have a valid ownership percentage (1–100).' }, { status: 400 })
    }
  }

  // 4. Validate total ownership = 100%
  const total = members.reduce((sum, m) => sum + parseFloat(String(m.ownership_pct || 0)), 0)
  if (Math.abs(total - 100) > 0.01) {
    return NextResponse.json(
      { error: `Ownership percentages must total 100%. Current total: ${total.toFixed(2)}%.` },
      { status: 400 },
    )
  }

  const now = new Date().toISOString()
  const accountId = request.account_id

  // 5. Delete existing members for this account, then insert new
  const { error: deleteErr } = await supabaseAdmin
    .from('members')
    .delete()
    .eq('account_id', accountId)

  if (deleteErr) {
    return NextResponse.json({ error: `Failed to clear existing members: ${deleteErr.message}` }, { status: 500 })
  }

  const insertRows = members.map((m, idx) => ({
    account_id: accountId,
    member_type: m.member_type,
    full_name: m.full_name?.trim() || null,
    company_name: m.company_name?.trim() || null,
    ein: m.ein?.trim() || null,
    email: m.email?.trim() || null,
    phone: m.phone?.trim() || null,
    ownership_pct: parseFloat(String(m.ownership_pct || 0)),
    is_primary: idx === 0,
    is_signer: idx === 0,
    address_street: m.address_street?.trim() || null,
    address_city: m.address_city?.trim() || null,
    address_state: m.address_state?.trim() || null,
    address_zip: m.address_zip?.trim() || null,
    address_country: m.address_country?.trim() || null,
    representative_name: m.representative_name?.trim() || null,
    representative_email: m.representative_email?.trim() || null,
    representative_phone: m.representative_phone?.trim() || null,
    representative_address_street: m.representative_address_street?.trim() || null,
    representative_address_city: m.representative_address_city?.trim() || null,
    representative_address_state: m.representative_address_state?.trim() || null,
    representative_address_zip: m.representative_address_zip?.trim() || null,
    representative_address_country: m.representative_address_country?.trim() || null,
    created_at: now,
    updated_at: now,
  }))

  const { error: insertErr } = await supabaseAdmin
    .from('members')
    .insert(insertRows)

  if (insertErr) {
    return NextResponse.json({ error: `Failed to save members: ${insertErr.message}` }, { status: 500 })
  }

  // 6. Mark request as submitted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('member_info_requests')
    .update({
      status: 'submitted',
      submitted_data: { members },
      submitted_at: now,
    })
    .eq('id', request.id)

  // 7. Log action
  await supabaseAdmin.from('action_log').insert({
    action_type: 'member_info_submitted',
    table_name: 'member_info_requests',
    record_id: request.id,
    account_id: accountId,
    summary: `Member info form submitted: ${members.length} member(s) applied to account ${accountId}`,
    details: { member_count: members.length, request_id: request.id },
  })

  return NextResponse.json({ success: true, member_count: members.length })
}
