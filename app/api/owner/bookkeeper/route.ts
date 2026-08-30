import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isOwnerOnly } from '@/lib/auth'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Check if fetching a specific review's items
  const { searchParams } = new URL(req.url)
  const reviewId = searchParams.get('id')
  if (reviewId) {
    const { data: itemData, error: itemError } = await db
      .from('bookkeeper_review_items')
      .select('*')
      .eq('review_id', reviewId)
      .order('item_number', { nullsFirst: false })
    if (itemError) return NextResponse.json({ error: itemError.message }, { status: 500 })
    return NextResponse.json({ items: itemData ?? [] })
  }

  const [reviewsRes, countsRes] = await Promise.all([
    db.from('bookkeeper_reviews').select('*').order('tax_year', { ascending: false }),
    db.from('bookkeeper_review_items').select('review_id, status'),
  ])

  if (reviewsRes.error) return NextResponse.json({ error: reviewsRes.error.message }, { status: 500 })
  const data = reviewsRes.data

  const allCounts = countsRes.data ?? []

  const reviews = (data ?? []).map(r => {
    const itemsForReview = allCounts.filter(i => i.review_id === r.id)
    return {
      ...r,
      total_items: itemsForReview.length,
      answered_items: itemsForReview.filter(i => i.status === 'answered').length,
    }
  })

  return NextResponse.json({ reviews })
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { tax_year, bookkeeper, source_file_name, source_file_drive_id, items } = body

  if (!tax_year) {
    return NextResponse.json({ error: 'tax_year is required' }, { status: 400 })
  }

  const { data: review, error: reviewError } = await db
    .from('bookkeeper_reviews')
    .upsert({
      tax_year,
      bookkeeper: bookkeeper ?? null,
      source_file_name: source_file_name ?? null,
      source_file_drive_id: source_file_drive_id ?? null,
      status: 'open',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tax_year' })
    .select()
    .single()

  if (reviewError) return NextResponse.json({ error: reviewError.message }, { status: 500 })

  if (Array.isArray(items) && items.length > 0) {
    const rows = items.map((item: Record<string, unknown>) => ({
      review_id: review.id,
      section: item.section,
      item_number: item.item_number ?? null,
      description: item.description,
      amount: item.amount ?? null,
      transaction_date: item.transaction_date ?? null,
      counterparty: item.counterparty ?? null,
      bank_account: item.bank_account ?? null,
      status: 'pending',
    }))

    const { error: itemsError } = await db
      .from('bookkeeper_review_items')
      .insert(rows)

    if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 })
  }

  return NextResponse.json({ review }, { status: 201 })
}
