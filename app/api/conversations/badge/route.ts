import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { unreadCountForStaff } from '@/lib/td-communication/queries'

export const dynamic = 'force-dynamic'

/** GET /api/conversations/badge — staff sidebar badge: unread partner messages. */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ count: 0 })
  try {
    return NextResponse.json({ count: await unreadCountForStaff() })
  } catch {
    return NextResponse.json({ count: 0 })
  }
}
