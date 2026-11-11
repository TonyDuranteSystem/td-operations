import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/auth'
import { raiseAndSendPlanPart } from '@/lib/plan-invoices/raise'

/**
 * POST /api/crm/admin-actions/raise-plan-part  { token, seq }
 *
 * Raises AND SENDS one later part of an offer's payment plan — only when a staff member clicks "Raise and send" on the Calendar's
 * "Invoices to raise" list (dev job ae3c19db). Nothing else calls it: no cron, no webhook. The payer, the amount and the
 * double-bill protection are decided by lib/plan-invoices/raise.ts, never by this request body (it only names WHICH part).
 * Staff only. Errors carry the real reason in `error` (R099) so the toast can say it.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { token?: unknown; seq?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'The request was not understood.' }, { status: 400 })
  }
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const seq = typeof body.seq === 'number' ? body.seq : Number(body.seq)
  if (!token || token.length > 200 || !Number.isInteger(seq) || seq < 2 || seq > 20) {
    return NextResponse.json({ error: 'Name the offer and the part (part 2 or later).' }, { status: 400 })
  }

  const result = await raiseAndSendPlanPart({ token, seq, actor: user.email ?? user.id })
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 409 })
  return NextResponse.json({ ok: true, message: result.message, invoice_number: result.invoiceNumber, sent: result.sent })
}
