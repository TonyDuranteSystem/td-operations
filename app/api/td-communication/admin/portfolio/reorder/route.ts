import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { reorderPortfolio } from '@/lib/td-communication/portfolio-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/admin/portfolio/reorder — persist a new display
 * order. ADMIN-ONLY (sort_order drives the public page). Body: { orderedIds: string[] }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  const body = await req.json().catch(() => ({}))
  const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds.filter((x: unknown) => typeof x === 'string') : null
  if (!orderedIds || orderedIds.length === 0) {
    return NextResponse.json({ error: 'orderedIds (array) required' }, { status: 400 })
  }
  try {
    await reorderPortfolio(orderedIds)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not reorder.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
