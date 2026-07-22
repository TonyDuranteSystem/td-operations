import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isValidKind, freshAddressClient, linkedAccountCount, nearDupeCheck } from '@/lib/addresses'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

/* eslint-disable @typescript-eslint/no-explicit-any */

// GET /api/addresses?kind=registered_agent&active=true
export async function GET(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { searchParams } = req.nextUrl
  const kind = searchParams.get('kind')
  const activeParam = searchParams.get('active')
  const active = activeParam === null ? true : activeParam === 'true'

  if (kind && !isValidKind(kind)) {
    return NextResponse.json(
      { error: 'Invalid kind. Must be one of: business_legal, business_mailing, registered_agent' },
      { status: 400 }
    )
  }

  const db = freshAddressClient()
  let query = (db as any).from('addresses').select('*').eq('active', active).order('name')
  if (kind) query = query.eq('kind', kind)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = await Promise.all(
    (data as Array<{ id: string } & Record<string, unknown>>).map(async (row) => ({
      ...row,
      linked_account_count: await linkedAccountCount(db, row.id),
    }))
  )

  return NextResponse.json(rows)
}

// POST /api/addresses
export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const body = await req.json()
  const { kind, name, address_line1, city, state, zip } = body

  if (!kind || !name || !address_line1 || !city || !state || !zip) {
    return NextResponse.json(
      { error: 'Missing required fields: kind, name, address_line1, city, state, zip' },
      { status: 400 }
    )
  }
  if (!isValidKind(kind)) {
    return NextResponse.json(
      { error: 'Invalid kind. Must be one of: business_legal, business_mailing, registered_agent' },
      { status: 400 }
    )
  }

  const db = freshAddressClient()
  const dupe = await nearDupeCheck(db, kind, address_line1, city, state).catch(() => null)

  const { data, error } = await (db as any)
    .from('addresses')
    .insert({
      kind,
      name,
      address_line1,
      address_line2: body.address_line2 ?? null,
      city,
      state,
      zip,
      country: body.country ?? 'US',
      county: body.county ?? null,
      provider: body.provider ?? null,
      agent_name: body.agent_name ?? null,
      is_td_provided: body.is_td_provided ?? false,
      notes: body.notes ?? null,
      created_by: body.created_by ?? null,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin.from('action_log').insert({
    action_type: 'address_created',
    table_name: 'addresses',
    record_id: data.id,
    summary: `Address created: "${data.name}" (${data.kind})`,
  })

  return NextResponse.json(
    { ...data, ...(dupe ? { warning: `Similar address already exists: "${dupe.name}"` } : {}) },
    { status: 201 }
  )
}

/* eslint-enable @typescript-eslint/no-explicit-any */
