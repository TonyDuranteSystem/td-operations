import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { markDelivered } from '@/lib/team/delivery'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/delivered — the RECEIVING device says "I have these conversations up to this moment" (the grey double
 * tick on the sender's screen). Body: { items: [{ thread_id, as_of }] }. Staff only; only your own direct messages and
 * groups you are in are recorded; the pointer only moves forward. See lib/team/delivery.ts.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  const body = await request.json().catch(() => ({}))
  const stored = await markDelivered(user.id, body.items)
  return NextResponse.json({ ok: true, stored })
}
