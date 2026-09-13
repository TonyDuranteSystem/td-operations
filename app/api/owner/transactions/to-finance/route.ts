/**
 * "This is for a client" — send a transaction from My Finances to Finance.
 *
 * ONE button, ONE endpoint, for both shapes of transaction (fixed 2026-09-11
 * after a bug-hunter pass found two separate buttons could sit on the same
 * row and collide — clicking the old feed-restore path on an already-linked
 * row deleted the record of that link and re-exposed real money for a
 * second credit):
 *   - A row that was ALREADY mirrored here from the Bank Feed (its own
 *     reference carries the feed id) — the system just couldn't prove it
 *     was a client payment. This returns the ORIGINAL feed row to the
 *     review queue.
 *   - A row NATIVE to My Finances (e.g. a wire to an account the Bank Feed
 *     doesn't watch) that the owner is manually confirming is a client
 *     payment. This CREATES a new Finance-side row for it — see
 *     lib/finance/owner-transaction-link.ts for why it's stamped rather
 *     than left as a plain, unmatched row.
 *
 * Either way, the actual invoice/note/write-off decision happens next, in
 * Finance — this endpoint only gets the money there. Admin-only, like the
 * rest of My Finances.
 */
import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { sendOwnerLedgerRowToFinance } from '@/lib/finance/owner-ledger-projection'
import { sendOwnerTransactionToFinance } from '@/lib/finance/owner-transaction-link'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { transaction_id?: string; transaction_ref?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const ref = body.transaction_ref?.trim() ?? ''

  if (ref.startsWith('feed:')) {
    const feedId = ref.slice('feed:'.length)
    const result = await sendOwnerLedgerRowToFinance(feedId)
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'Could not move it.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  const transactionId = body.transaction_id?.trim() ?? ''
  if (!transactionId) {
    return NextResponse.json({ error: 'Missing transaction.' }, { status: 400 })
  }
  const result = await sendOwnerTransactionToFinance(
    transactionId,
    `dashboard:${user.email?.split('@')[0] ?? 'owner'}`,
  )
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not move it.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
