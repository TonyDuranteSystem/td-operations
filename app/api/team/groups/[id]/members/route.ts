import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { addGroupMembers, leaveGroup } from '@/lib/team/groups'
import { NextRequest, NextResponse } from 'next/server'

/** POST /api/team/groups/[id]/members — add people (any member). Body: { user_ids }. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const r = await addGroupMembers(id, user.id, body.user_ids)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json(r.value)
}

/** DELETE /api/team/groups/[id]/members — leave the group. Only ever removes YOU (nobody can remove someone else). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  const { id } = await params
  const r = await leaveGroup(id, user.id)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json(r.value)
}
