import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

export const dynamic = 'force-dynamic'

/**
 * GET /api/invoice-settings
 * Returns the single invoice settings row.
 */
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('invoice_settings')
    .select('*')
    .limit(1)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data })
}

/**
 * PUT /api/invoice-settings
 * Update invoice settings. Body: partial fields.
 */
export async function PUT(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  // Ensure every bank account carries a stable id. Invoices reference a specific
  // bank by identity (`settings_bank:<id>`), not by list position, so reordering or
  // deleting a bank never repoints existing invoices. Assign an id to any bank
  // missing one (covers banks created before the id-based scheme).
  if (Array.isArray(body.bank_accounts)) {
    body.bank_accounts = body.bank_accounts.map((b: Record<string, unknown>) =>
      b && typeof b === 'object' && !b.id ? { ...b, id: randomUUID() } : b,
    )
  }

  // Get existing settings ID
  const { data: existing } = await supabaseAdmin
    .from('invoice_settings')
    .select('id')
    .limit(1)
    .single()

  if (!existing) return NextResponse.json({ error: 'Settings not found' }, { status: 404 })

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

  const allowedFields = [
    'company_name', 'company_address', 'company_email', 'company_phone',
    'tax_id', 'logo_url', 'invoice_prefix', 'invoice_footer',
    'default_payment_terms', 'bank_accounts', 'payment_gateways',
  ]

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field]
    }
  }

  const { data, error } = await supabaseAdmin
    .from('invoice_settings')
    .update(updates)
    .eq('id', existing.id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data })
}
