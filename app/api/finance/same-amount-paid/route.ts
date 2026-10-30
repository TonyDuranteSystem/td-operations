/**
 * The already-PAID invoices of exactly this payment's amount, for the Bank Feed's "Match to invoice" popup —
 * whoever they belong to, so it works when nobody knows who paid.
 *
 *   GET /api/finance/same-amount-paid?feed_id=<uuid>              paid within 3 days of the payment (the everyday look)
 *   GET /api/finance/same-amount-paid?feed_id=<uuid>&days=30      the wider look, behind a link in the popup
 *
 * Read-only. Any logged-in staff member, same as the rest of Finance (it is plain invoice data, no mailbox, no AI);
 * TD's own private transactions are refused for anyone but the owner. Nothing is linked here: the rows join the
 * popup's existing "link for the record" selection, whose server-side checks are unchanged.
 */
import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { loadSameAmountPaid } from '@/lib/finance/same-amount-paid'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const feedId = searchParams.get('feed_id')?.trim() ?? ''
  if (!UUID.test(feedId)) return NextResponse.json({ error: 'A transaction is required.' }, { status: 400 })

  const result = await loadSameAmountPaid({ feedId, days: searchParams.get('days'), isOwner: isOwnerOnly(user) })
  if (!result.ok) {
    const notFound = result.error === 'Transaction not found.'
    return NextResponse.json({ error: result.error ?? 'Could not load the paid invoices.' }, { status: notFound ? 404 : 500 })
  }
  return NextResponse.json(result)
}
