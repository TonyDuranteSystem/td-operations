import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { checkRateLimit } from '@/lib/portal/rate-limit'
import { checkIdea } from '@/lib/portal/feature-ideas'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/feature-ideas { account_id, idea } — a client shares a feature idea from the box at the bottom of
 * Customers & Invoices. Stored for staff (Portal Chats > Idea request). The client's own company only.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 5 ideas per hour per person is plenty and stops a stuck button or a bot from flooding staff.
  const rl = checkRateLimit(`feature-ideas:${user.id}`, 5, 60 * 60 * 1000)
  if (!rl.allowed) return NextResponse.json({ error: 'You have sent a few ideas already. Please try again a little later.' }, { status: 429 })

  const body = await request.json().catch(() => ({})) as { account_id?: unknown; idea?: unknown }
  const check = checkIdea(body.idea)
  if ('error' in check) return NextResponse.json({ error: check.error }, { status: 400 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const accountId = typeof body.account_id === 'string' ? body.account_id : null
  if (accountId) {
    const mine = await getClientAccountIds(contactId)
    if (!mine.includes(accountId)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // portal_feature_ideas is new and not in the generated database types yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any).from('portal_feature_ideas').insert({
    account_id: accountId,
    contact_id: contactId,
    auth_user_id: user.id,
    idea: check.idea,
  })
  if (error) return NextResponse.json({ error: 'Could not send your idea. Please try again.' }, { status: 500 })
  return NextResponse.json({ success: true })
}
