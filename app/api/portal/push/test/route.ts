import { createClient } from '@/lib/supabase/server'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { mayTestPushForAccount } from '@/lib/portal/push-test-access'
import { sendPushToAccount } from '@/lib/portal/web-push'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/push/test — Send a test push notification
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { account_id } = body as { account_id?: unknown }

  // Access control: only a client of that company or a team member of that company (everything else is refused, including logins with no client record)
  const identity = await resolvePortalIdentity(user)
  if (!mayTestPushForAccount(identity, account_id)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const result = await sendPushToAccount(account_id, {
    title: 'TD Portal',
    body: 'Push notifications are working! You will receive alerts for documents, services, and deadlines.',
    url: '/portal',
    tag: 'test-notification',
    clientKind: 'test',
  })

  return NextResponse.json(result)
}
