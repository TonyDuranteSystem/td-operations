import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextResponse } from 'next/server'
import {
  getOwnerPnL,
  getCashPosition,
  getUncategorizedCount,
  getVendorRules,
} from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10)

  const [pnl, cash, uncategorized, rules] = await Promise.all([
    getOwnerPnL(year),
    getCashPosition(),
    getUncategorizedCount(year),
    getVendorRules(),
  ])

  return NextResponse.json({
    year,
    pnl,
    cash,
    uncategorized_count: uncategorized,
    vendor_rules_count: rules.length,
  })
}
