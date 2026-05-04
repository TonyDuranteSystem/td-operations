import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { getOwnerPnL } from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10)
  const compare = searchParams.get('compare') === 'true'

  const current = await getOwnerPnL(year)

  if (!compare) {
    return NextResponse.json({ pnl: current })
  }

  const prior = await getOwnerPnL(year - 1)

  const variance = {
    income: current.income - prior.income,
    income_pct: prior.income !== 0 ? (current.income - prior.income) / prior.income : null,
    cogs: current.cogs - prior.cogs,
    gross_profit: current.gross_profit - prior.gross_profit,
    gross_profit_pct: prior.gross_profit !== 0
      ? (current.gross_profit - prior.gross_profit) / prior.gross_profit
      : null,
    expenses: current.expenses - prior.expenses,
    net_profit: current.net_profit - prior.net_profit,
    net_profit_pct: prior.net_profit !== 0
      ? (current.net_profit - prior.net_profit) / prior.net_profit
      : null,
  }

  return NextResponse.json({ pnl: current, prior, variance })
}
