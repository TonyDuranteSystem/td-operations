import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/auth'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'
import { NextResponse } from 'next/server'

/**
 * POST /api/admin/push/test — send a test push to THE CALLER'S OWN devices.
 *
 * It used to broadcast to every registered device, so one person checking their
 * own notifications buzzed the whole team. Testing your own push is a per-user
 * question and now gets a per-user answer. Staff-only, like the subscribe route.
 */
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isStaffUser(user)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const result = await sendPushToAdminUsers([user.id], {
    title: 'TD Portal Test',
    body: 'Admin push notifications are working!',
    url: '/portal-chats',
    tag: 'admin-test-notification',
  })

  return NextResponse.json(result)
}
