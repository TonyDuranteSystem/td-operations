import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { freshAddressClient, linkedAccountCount } from '@/lib/addresses'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { stateCode } from '@/lib/formation/registered-agent-state'

/* eslint-disable @typescript-eslint/no-explicit-any */

const MUTABLE_FIELDS = new Set([
  'kind', 'name', 'provider', 'agent_name',
  'address_line1', 'address_line2', 'city', 'state', 'zip', 'country',
  'county', 'is_td_provided', 'notes',
])

// PATCH /api/addresses/[id]
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

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

  // A registered-agent entry that companies are using cannot be moved to another STATE (dev job ff2b73d7): their SS-4 Line 6 is copied
  // from it, so changing "WY" to "NM" on the Sheridan entry would make a wrong-state agent look right (Line 6 would read "Sheridan
  // County, New Mexico") and break every Wyoming company on it. The right move is a new entry for the other state.
  if (typeof updates.state === 'string') {
    const { data: before, error: beforeErr } = await (db as any).from('addresses').select('kind, state').eq('id', params.id).maybeSingle()
    if (beforeErr) return NextResponse.json({ error: beforeErr.message }, { status: 500 })
    if (before && before.kind === 'registered_agent' && stateCode(before.state) !== stateCode(updates.state as string)) {
      const used = await linkedAccountCount(db, params.id)
      if (used > 0) {
        return NextResponse.json(
          { error: `This registered agent entry is used by ${used} ${used === 1 ? 'company' : 'companies'}, so its state cannot be changed — their SS-4 Line 6 is copied from it. Add a new entry for the other state instead.`, linked_account_count: used },
          { status: 409 },
        )
      }
    }
  }

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
  const denied = await requireStaffRoute()
  if (denied) return denied

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
