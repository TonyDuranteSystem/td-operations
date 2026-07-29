import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { isOwnerCategory } from '@/lib/owner-finance'
import { normalizeVendorKey } from '@/lib/owner-vendor-match'

const MATCH_TYPES = ['exact', 'contains', 'regex'] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const dynamic = 'force-dynamic'

export async function GET(_req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await db
    .from('owner_vendor_rules')
    .select('*')
    .order('counterparty_pattern')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rules: data })
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { counterparty_pattern, match_type, category, subcategory, is_related_party, notes } = body

  if (!counterparty_pattern || !category || !subcategory) {
    return NextResponse.json({ error: 'counterparty_pattern, category, and subcategory are required' }, { status: 400 })
  }
  if (!isOwnerCategory(category)) {
    return NextResponse.json({ error: `Unknown category "${category}"` }, { status: 400 })
  }
  const resolvedMatchType = match_type ?? 'contains'
  if (!MATCH_TYPES.includes(resolvedMatchType)) {
    return NextResponse.json({ error: `match_type must be one of: ${MATCH_TYPES.join(', ')}` }, { status: 400 })
  }
  // A contains-pattern that normalizes to nothing would match EVERY transaction
  // (empty-string containment is always true) — refuse it at the door.
  if (resolvedMatchType === 'contains' && !normalizeVendorKey(counterparty_pattern)) {
    return NextResponse.json({ error: 'Pattern has no matchable text' }, { status: 400 })
  }

  // Re-saving the same pattern is a changed mind, not a second rule: without this, two
  // rows with the same pattern coexist and which one fires is undefined forever.
  const { data: existing } = await db
    .from('owner_vendor_rules')
    .select('id')
    .eq('counterparty_pattern', counterparty_pattern)
    .eq('match_type', resolvedMatchType)
    .limit(1)

  if (existing && existing.length > 0) {
    const { data, error } = await db
      .from('owner_vendor_rules')
      .update({ category, subcategory, is_related_party: is_related_party ?? false, notes: notes ?? null, updated_at: new Date().toISOString() })
      .eq('id', existing[0].id)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ rule: data, updated_existing: true })
  }

  const { data, error } = await db
    .from('owner_vendor_rules')
    .insert({
      counterparty_pattern,
      match_type: resolvedMatchType,
      category,
      subcategory,
      is_related_party: is_related_party ?? false,
      notes: notes ?? null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rule: data }, { status: 201 })
}

export async function PATCH(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { id, ...updates } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { data, error } = await db
    .from('owner_vendor_rules')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rule: data })
}

export async function DELETE(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await db
    .from('owner_vendor_rules')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true })
}
