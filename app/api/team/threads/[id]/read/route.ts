import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { markThreadRead } from '@/lib/team/mark-thread-read'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/read
 * Advance the caller's read pointer for a thread (per-user unread model).
 * Lightweight companion to GET /threads/[id] for when the client just wants to
 * clear the badge without refetching messages. Staff-only.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: threadId } = await params

  const error = await markThreadRead(user.id, threadId)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true })
}
