import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { assertGroupAccess, renameGroup } from '@/lib/team/groups'
import { NextRequest, NextResponse } from 'next/server'

/** GET /api/team/groups/[id] — the group's member ids (members only). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  const { id } = await params
  const access = await assertGroupAccess(id, user.id)
  if (access.kind === 'denied') return NextResponse.json({ error: 'You are not in this group.' }, { status: 403 })
  if (access.kind !== 'member') return NextResponse.json({ error: 'Group not found.' }, { status: 404 })
  return NextResponse.json({ members: access.members })
}

/** PATCH /api/team/groups/[id] — rename (any member). Body: { name }. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const r = await renameGroup(id, user.id, body.name)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json(r.value)
}
