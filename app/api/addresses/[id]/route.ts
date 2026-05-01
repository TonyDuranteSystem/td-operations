import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { freshAddressClient, linkedAccountCount } from '@/lib/addresses'

/* eslint-disable @typescript-eslint/no-explicit-any */

const MUTABLE_FIELDS = new Set([
  'kind', 'name', 'provider', 'agent_name',
  'address_line1', 'address_line2', 'city', 'state', 'zip', 'country',
  'county', 'is_td_provided', 'notes',
])

// PATCH /api/addresses/[id]
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()

  const updates: Record<string, unknown> = {}
  Object.entries(body).forEach(([k, v]) => {
    if (MUTABLE_FIELDS.has(k)) updates[k] = v
  })

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  updates.updated_at = new Date().toISOString()

  const db = freshAddressClient()
  const { data, error } = await (db as any)
    .from('addresses')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Address not found' }, { status: 404 })

  const count = await linkedAccountCount(db, params.id)

  await supabaseAdmin.from('action_log').insert({
    action_type: 'address_updated',
    table_name: 'addresses',
    record_id: params.id,
    summary: `Address updated: "${data.name}" (${data.kind})`,
  })

  return NextResponse.json({ ...data, linked_account_count: count })
}

// DELETE /api/addresses/[id]
// Soft-delete: sets active=false. Blocked with 409 if any active accounts are linked.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = freshAddressClient()
  const count = await linkedAccountCount(db, params.id)

  if (count > 0) {
    return NextResponse.json(
      { error: `Cannot deactivate: ${count} account(s) still linked`, linked_account_count: count },
      { status: 409 }
    )
  }

  const { error } = await (db as any)
    .from('addresses')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin.from('action_log').insert({
    action_type: 'address_deactivated',
    table_name: 'addresses',
    record_id: params.id,
    summary: `Address soft-deleted (active=false). No active accounts were linked.`,
  })

  return NextResponse.json({ ok: true })
}

/* eslint-enable @typescript-eslint/no-explicit-any */
