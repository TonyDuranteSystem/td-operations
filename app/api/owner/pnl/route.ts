import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { getOwnerPnL } from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10)
  const compare = searchParams.get('compare') === 'true'

  const current = await getOwnerPnL(year)

  if (!compare) {
    return NextResponse.json({ pnl: current })
  }

  // The tab computes per-currency variance client-side from the two P&Ls — no separate
  // variance payload (a second copy of the math would only drift).
  const prior = await getOwnerPnL(year - 1)
  return NextResponse.json({ pnl: current, prior })
}
