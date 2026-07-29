import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { getOwnerTransactionsPaginated, isOwnerCategory, TD_ENTITY_ID, type OwnerCategory } from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10)
  const category = searchParams.get('category') as OwnerCategory | null
  const search = searchParams.get('search') ?? undefined
  const bank = searchParams.get('bank') ?? undefined
  const limit = parseInt(searchParams.get('limit') ?? '50', 10)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

  const result = await getOwnerTransactionsPaginated(year, {
    category: category ?? undefined,
    search,
    bank,
    limit,
    offset,
  })

  return NextResponse.json(result)
}

export async function PATCH(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { id, category, subcategory, notes, is_related_party } = body

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  if (category !== undefined && !isOwnerCategory(category)) {
    return NextResponse.json({ error: `Unknown category "${category}"` }, { status: 400 })
  }

  const update: Record<string, unknown> = {}
  if (category !== undefined) update.category = category
  if (subcategory !== undefined) update.subcategory = subcategory
  if (notes !== undefined) update.notes = notes
  if (is_related_party !== undefined) update.is_related_party = is_related_party

  const { data, error } = await supabaseAdmin
    .from('td_books_transactions')
    .update(update)
    .eq('id', id)
    .eq('entity_id', TD_ENTITY_ID)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ transaction: data })
}
