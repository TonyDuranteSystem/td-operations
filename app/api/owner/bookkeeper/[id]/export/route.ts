import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isOwnerOnly } from '@/lib/auth'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [reviewRes, itemsRes] = await Promise.all([
    db.from('bookkeeper_reviews').select('id, tax_year, bookkeeper, status').eq('id', params.id).single(),
    db.from('bookkeeper_review_items').select('*').eq('review_id', params.id).order('item_number', { nullsFirst: false }),
  ])

  if (reviewRes.error || !reviewRes.data) {
    return NextResponse.json({ error: reviewRes.error?.message ?? 'Not found' }, { status: 404 })
  }

  const review = reviewRes.data as Record<string, unknown>
  const items = (itemsRes.data ?? []) as Array<Record<string, unknown>>
  const answered = items.filter((i: Record<string, unknown>) => i.status === 'answered')

  const sections = ['Bank & Credit Card', 'Profit & Loss', 'Balance Sheet']
  let text = `Bookkeeper Review Response — ${review.tax_year}\n`
  text += `Prepared: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n\n`

  for (const section of sections) {
    const sectionItems = answered.filter((i: Record<string, unknown>) => i.section === section)
    if (sectionItems.length === 0) continue

    text += `## ${section}\n\n`
    for (const item of sectionItems) {
      text += `**Item ${item.item_number ?? ''}:** ${item.description}\n`
      if (item.amount) text += `Amount: $${Number(item.amount).toLocaleString()}\n`
      text += `**Response:** ${item.answer}\n`
      if (item.answer_category) text += `Category: ${item.answer_category}\n`
      text += '\n'
    }
  }

  const pending = items.filter((i: Record<string, unknown>) => i.status === 'pending')
  if (pending.length > 0) {
    text += `---\n**${pending.length} item(s) still pending review.**\n`
  }

  return NextResponse.json({
    review_id: review.id,
    tax_year: review.tax_year,
    bookkeeper: review.bookkeeper,
    answered_count: answered.length,
    pending_count: pending.length,
    export_text: text,
  })
}
