/**
 * The invoices to offer for ONE bank transaction in the Bank Feed's "Match to invoice" popup:
 * the company (or person) this payer was linked to before, with every invoice — paid and
 * unpaid — and any set of them that adds up to the payment exactly.
 *
 *   GET /api/finance/payer-invoices?feed_id=<uuid>
 *   GET /api/finance/payer-invoices?feed_id=<uuid>&account_id=<uuid>   (a company the person searched)
 *   GET /api/finance/payer-invoices?feed_id=<uuid>&contact_id=<uuid>   (a person the person searched)
 *
 * Read-only. Any logged-in staff member, same as the rest of Finance; TD's own private
 * transactions are refused for anyone but the owner (see loadPayerInvoices).
 */
import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { loadPayerInvoices } from '@/lib/finance/payer-invoices'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const feedId = searchParams.get('feed_id')?.trim() ?? ''
  const accountId = searchParams.get('account_id')?.trim() || null
  const contactId = searchParams.get('contact_id')?.trim() || null
  if (!UUID.test(feedId)) return NextResponse.json({ error: 'A transaction is required.' }, { status: 400 })
  if ((accountId && !UUID.test(accountId)) || (contactId && !UUID.test(contactId))) {
    return NextResponse.json({ error: 'Invalid company.' }, { status: 400 })
  }

  const result = await loadPayerInvoices({ feedId, accountId, contactId, isOwner: isOwnerOnly(user) })
  if (!result.ok) {
    const notFound = result.error === 'Transaction not found.'
    return NextResponse.json({ error: result.error ?? 'Could not load the invoices.' }, { status: notFound ? 404 : 500 })
  }
  return NextResponse.json(result)
}
