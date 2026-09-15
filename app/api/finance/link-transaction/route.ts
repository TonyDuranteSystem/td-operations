/**
 * Link a Finance-side bank transaction to a client invoice — the popup:
 * pick the invoice, write a note, say whether this closes it (writing off
 * the remainder). Any logged-in staff member, same as the rest of Finance.
 */
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { linkFeedTransactionToInvoice } from '@/lib/finance/owner-transaction-link'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { feed_id?: string; payment_id?: string; note?: string; write_off_remaining?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const feedId = body.feed_id?.trim() ?? ''
  const paymentId = body.payment_id?.trim() ?? ''
  const note = body.note?.trim() ?? ''
  if (!feedId || !paymentId) {
    return NextResponse.json({ error: 'A transaction and an invoice are both required.' }, { status: 400 })
  }
  if (!note) {
    return NextResponse.json({ error: 'A note explaining this is required.' }, { status: 400 })
  }

  const result = await linkFeedTransactionToInvoice({
    feedId,
    paymentId,
    note,
    writeOffRemaining: body.write_off_remaining === true,
    actor: `dashboard:${user.email?.split('@')[0] ?? 'staff'}`,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not link this transaction.' }, { status: 400 })
  }
  return NextResponse.json({
    ok: true,
    invoiceNumber: result.invoiceNumber,
    newStatus: result.newStatus,
    newAmountPaid: result.newAmountPaid,
    newAmountDue: result.newAmountDue,
    auditLink: result.auditLink === true,
  })
}
