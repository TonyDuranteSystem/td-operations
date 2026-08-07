/**
 * GET /api/portal/chat/audience?account_id=xxx
 *
 * Staff-only. Answers: "if I tag a message with this company, who will see
 * it?" — every linked contact plus every active portal teammate with the chat
 * capability. The staff composer uses this to warn before a company-tagged
 * send whenever the audience is wider than the one person being answered,
 * INCLUDING a solo company with chat-capable teammates (the case a
 * members-only count misses — 2026-08-07 leak review, dev job 4bad3094).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { accountAudience } from '@/lib/portal/admin-send-scope'

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const accountId = request.nextUrl.searchParams.get('account_id')
  if (!accountId) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  const audience = await accountAudience(accountId)
  return NextResponse.json({
    contact_count: audience.contactCount,
    chat_teammate_count: audience.chatTeammateCount,
  })
}
