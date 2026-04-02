import { createClient } from '@/lib/supabase/server'
import { sendPushToAdmin } from '@/lib/portal/web-push'
import { NextResponse } from 'next/server'

/**
 * POST /api/admin/push/test — Send a test push notification to all admin devices
 */
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Any authenticated dashboard user can test push

  const result = await sendPushToAdmin({
    title: 'TD Portal Test',
    body: 'Admin push notifications are working!',
    url: '/portal-chats',
    tag: 'admin-test-notification',
  })

  return NextResponse.json(result)
}
