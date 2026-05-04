import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { OWNER_ACCOUNT_ID } from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { ids, category, subcategory, notes, is_related_party } = body

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
  }
  if (!category) {
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  }

  const update: Record<string, unknown> = { category }
  if (subcategory !== undefined) update.subcategory = subcategory
  if (notes !== undefined) update.notes = notes
  if (is_related_party !== undefined) update.is_related_party = is_related_party

  const { error, count } = await supabaseAdmin
    .from('bank_transactions')
    .update(update)
    .in('id', ids)
    .eq('account_id', OWNER_ACCOUNT_ID)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ updated: count })
}
