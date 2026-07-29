import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { isOwnerCategory, TD_ENTITY_ID } from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { ids, category, subcategory, notes, is_related_party, only_uncategorized } = body

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }
  if (!category) {
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  }
  if (!isOwnerCategory(category)) {
    return NextResponse.json({ error: `Unknown category "${category}"` }, { status: 400 })
  }

  const update: Record<string, unknown> = { category }
  if (subcategory !== undefined) update.subcategory = subcategory
  if (notes !== undefined) update.notes = notes
  if (is_related_party !== undefined) update.is_related_party = is_related_party

  // Chunked: supabase-js encodes `.in()` filters in the request URL, and a first-cleanup
  // apply-to-all can carry hundreds of ids — one giant request would be rejected by the
  // gateway with an opaque error. 200 ids ≈ 7.5KB of URL: safe.
  const CHUNK = 200
  let updated = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    let q = supabaseAdmin
      .from('td_books_transactions')
      .update(update, { count: 'exact' })
      .in('id', ids.slice(i, i + CHUNK))
      .eq('entity_id', TD_ENTITY_ID)

    // The apply-to-all path snapshots its id set at modal-open; a row categorized in the
    // meantime (phone + desktop is a real pattern here) must NOT be silently overwritten.
    if (only_uncategorized) q = q.eq('category', 'uncategorized')

    const { error, count } = await q
    if (error) {
      return NextResponse.json({ error: error.message, updated }, { status: 500 })
    }
    updated += count ?? 0
  }

  return NextResponse.json({ updated })
}
