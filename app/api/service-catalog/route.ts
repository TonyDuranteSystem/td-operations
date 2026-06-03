import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/service-catalog
 * Returns services sorted by sort_order.
 *
 *   ?include_inactive=true   → return all (active + inactive)
 *   ?contact_eligible=true   → restrict to services tagged 'contact_eligible'
 *                              in catalog_entries(catalog_id='services'). Used
 *                              by the contact-detail Add Service dialog so
 *                              only services that legitimately exist on a
 *                              contact without an account (ITIN, Banking
 *                              Physical, Formation, Notary, Shipping,
 *                              Consulting per the catalog tag) are listed.
 *                              Adding a new contact-eligible service tomorrow
 *                              = one INSERT to the catalog tag, no code change.
 *
 *   default                  → active only
 */
export async function GET(request: NextRequest) {
  const includeInactive = request.nextUrl.searchParams.get('include_inactive') === 'true'
  const contactEligibleOnly = request.nextUrl.searchParams.get('contact_eligible') === 'true'

  let query = supabaseAdmin
    .from('service_catalog')
    .select('id, name, slug, category, pipeline, contract_type, has_annual, default_price, default_currency, sort_order, description, active, supports_quantity, default_service_context')
    .order('sort_order', { ascending: true })

  if (!includeInactive) {
    query = query.eq('active', true)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let services = data ?? []
  if (contactEligibleOnly) {
    // Join with catalog_entries.services on slug; keep only rows whose tag
    // array includes 'contact_eligible'. Two-query approach (over a SQL join)
    // because service_catalog and catalog_entries live in the same schema but
    // PostgREST can't natively join non-FK tables here. Both queries are tiny.
    const { data: eligible } = await supabaseAdmin
      .from('catalog_entries')
      .select('slug, tags')
      .eq('catalog_id', 'services')
      .eq('status', 'active')
    const eligibleSlugs = new Set(
      (eligible ?? [])
        .filter(e => {
          const tags = (e.tags as unknown[] | null) ?? []
          return Array.isArray(tags) && tags.includes('contact_eligible')
        })
        .map(e => e.slug as string),
    )
    services = services.filter(s => s.slug && eligibleSlugs.has(s.slug))
  }

  return NextResponse.json({ services })
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

  // service_catalog is a view (INSTEAD OF trigger handles DML); cast past generated view types — see af35ebac
  const { data, error } = await (supabaseAdmin as any)
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

/**
 * DELETE /api/service-catalog
 * Body: { id }
 *
 * Soft-deactivate the service (sets active=false). The existing service-catalog
 * list page already calls this method — but the endpoint was missing, so every
 * deactivate click was 405-ing silently. Surfaced in 2026-05-18 when Antonio
 * tried to deactivate the V2 test service from the editor consolidation pass.
 *
 * Soft delete (not hard) because:
 *   - existing service_deliveries rows reference service_catalog by name
 *   - hard delete would break historical reporting
 *   - reactivate is a 1-click PUT { id, active: true } via the same UI
 */
export async function DELETE(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { id } = body
  if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 })

  // service_catalog is a view (INSTEAD OF trigger handles DML); cast past generated view types — see af35ebac
  const { error } = await (supabaseAdmin as any)
    .from('service_catalog')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
