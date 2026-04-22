import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/service-catalog
 * Returns all active services sorted by sort_order.
 */
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('service_catalog')
    .select('id, name, slug, category, pipeline, contract_type, has_annual, default_price, default_currency, sort_order, description, supports_quantity')
    .eq('active', true)
    .order('sort_order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ services: data ?? [] })
}

/**
 * POST /api/service-catalog
 * Create a new service. Body: { name, default_price?, default_currency? }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { name, default_price, default_currency } = body

  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  // Get max sort_order
  const { data: maxRow } = await supabaseAdmin
    .from('service_catalog')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single()

  const nextOrder = (maxRow?.sort_order ?? 0) + 1

  const { data, error } = await supabaseAdmin
    .from('service_catalog')
    .insert({
      name: name.trim(),
      default_price: default_price != null ? Number(default_price) : null,
      default_currency: default_currency || 'USD',
      sort_order: nextOrder,
    })
    .select('id, name, default_price, default_currency, sort_order')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ service: data })
}

/**
 * PUT /api/service-catalog
 * Update a service. Body: { id, name?, default_price?, default_currency?, active? }
 */
export async function PUT(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { id, ...updates } = body

  if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 })

  const cleanUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.name !== undefined) cleanUpdates.name = updates.name.trim()
  if (updates.default_price !== undefined) cleanUpdates.default_price = updates.default_price != null ? Number(updates.default_price) : null
  if (updates.default_currency !== undefined) cleanUpdates.default_currency = updates.default_currency
  if (updates.active !== undefined) cleanUpdates.active = updates.active

  const { data, error } = await supabaseAdmin
    .from('service_catalog')
    .update(cleanUpdates)
    .eq('id', id)
    .select('id, name, default_price, default_currency, sort_order, active')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ service: data })
}
