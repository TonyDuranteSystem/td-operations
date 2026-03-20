import { createClient } from '@/lib/supabase/server'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { sendPushToAccount } from '@/lib/portal/web-push'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/push/test — Send a test push notification
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id } = body

  // Access control
  const contactId = getClientContactId(user)
  if (contactId && account_id) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  const result = await sendPushToAccount(account_id, {
    title: 'TD Portal',
    body: 'Push notifications are working! You will receive alerts for documents, services, and deadlines.',
    url: '/portal',
    tag: 'test-notification',
  })

  return NextResponse.json(result)
}
