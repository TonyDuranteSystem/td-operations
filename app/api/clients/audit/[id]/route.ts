import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from('accounts')
    .select('business_legal_address_id, business_mailing_address_id, registered_agent_id, legal_link_verified, mailing_link_verified, ra_link_verified, updated_at')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

/* eslint-disable no-restricted-syntax */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { account, contact, contacts } = await req.json()

  if (account && Object.keys(account).length > 0) {
    const { error: accErr } = await supabaseAdmin
      .from('accounts')
      .update(account)
      .eq('id', params.id)
    if (accErr) return NextResponse.json({ error: accErr.message }, { status: 500 })
  }

  // Single contact (backward compat)
  if (contact?.id) {
    const { id: contactId, ...contactFields } = contact
    const { error: conErr } = await supabaseAdmin
      .from('contacts')
      .update(contactFields)
      .eq('id', contactId)
    if (conErr) return NextResponse.json({ error: conErr.message }, { status: 500 })
  }

  // Multiple contacts array
  if (Array.isArray(contacts)) {
    for (const c of contacts) {
      if (!c?.id) continue
      const { id: contactId, ...contactFields } = c
      const { error: conErr } = await supabaseAdmin
        .from('contacts')
        .update(contactFields)
        .eq('id', contactId)
      if (conErr) return NextResponse.json({ error: conErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true })
}
/* eslint-enable no-restricted-syntax */
