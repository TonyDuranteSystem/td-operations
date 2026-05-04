import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; itemId: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { answer, answer_category, status, tx_id } = body

  const update: Record<string, unknown> = {}
  if (answer !== undefined) update.answer = answer
  if (answer_category !== undefined) update.answer_category = answer_category
  if (tx_id !== undefined) update.tx_id = tx_id
  if (status !== undefined) {
    update.status = status
    if (status === 'answered') update.answered_at = new Date().toISOString()
  }

  const { data, error } = await db
    .from('bookkeeper_review_items')
    .update(update)
    .eq('id', params.itemId)
    .eq('review_id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}
