import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const ALLOWED_FIELDS = ['status', 'data_received'] as const
type AllowedField = (typeof ALLOWED_FIELDS)[number]

/* eslint-disable no-restricted-syntax */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()

  const updates: Record<string, unknown> = {}
  for (const field of ALLOWED_FIELDS) {
    if (field in body) {
      updates[field] = body[field]
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const unknownFields = Object.keys(body).filter(k => !ALLOWED_FIELDS.includes(k as AllowedField))
  if (unknownFields.length > 0) {
    return NextResponse.json({ error: `Unknown fields: ${unknownFields.join(', ')}` }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('tax_returns')
    .update(updates)
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
/* eslint-enable no-restricted-syntax */
