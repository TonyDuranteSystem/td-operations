import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureStaff } from '@/lib/td-communication/admin-auth'
import { getRevenueDashboard } from '@/lib/td-communication/revenue-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/admin/revenue — full revenue dashboard (projects,
 * payouts, totals) for the CRM Revenue tab. Staff-only (ensureStaff blocks the
 * partner, who must never see client price/margin here).
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = await ensureStaff(user)
  if (gate) return gate

  try {
    const dashboard = await getRevenueDashboard()
    return NextResponse.json({ dashboard })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load revenue.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
