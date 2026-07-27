/**
 * "This is for a client" — move a transaction out of My Finances and back to the Bank Feed.
 *
 * The escape hatch for the default rule: anything the system cannot positively identify as a
 * client invoice payment lands in My Finances, and this puts it back in one click. Admin-only,
 * like the rest of My Finances.
 *
 * Takes the transaction's own reference (which carries the bank-feed id), removes the copy
 * from the owner's books, and returns the feed to the review queue.
 */
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { sendOwnerLedgerRowToFinance } from '@/lib/finance/owner-ledger-projection'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { transaction_ref?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const ref = body.transaction_ref?.trim() ?? ''
  // Only rows that CAME from the bank feed can go back to it — a hand-imported row has no
  // feed to return to, and silently doing nothing would look like the button was broken.
  if (!ref.startsWith('feed:')) {
    return NextResponse.json(
      { error: 'This transaction did not come from the bank feed, so it cannot be sent to Finance.' },
      { status: 400 },
    )
  }

  const feedId = ref.slice('feed:'.length)
  const result = await sendOwnerLedgerRowToFinance(feedId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Could not move it.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
