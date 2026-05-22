import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabaseAdmin as any

async function requireAdmin() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }
  return null
}

/**
 * PATCH /api/crm/portal-announcements/[id]
 * Update an announcement (toggle active, edit title/message/type/dismissible).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAdmin()
  if (auth) return auth

  const body = await request.json().catch(() => null) as {
    title?: string
    message?: string
    title_en?: string | null
    message_en?: string | null
    type?: string
    active?: boolean
    dismissible?: boolean
    active_from?: string | null
    active_until?: string | null
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim()
  if (typeof body.message === 'string' && body.message.trim()) patch.message = body.message.trim()
  if ('title_en' in body) patch.title_en = body.title_en?.trim() || null
  if ('message_en' in body) patch.message_en = body.message_en?.trim() || null
  if (typeof body.active === 'boolean') patch.active = body.active
  if (typeof body.dismissible === 'boolean') patch.dismissible = body.dismissible
  if (typeof body.type === 'string' && ['info', 'warning', 'success'].includes(body.type)) {
    patch.type = body.type
  }
  if ('active_from' in body) patch.active_from = body.active_from || null
  if ('active_until' in body) patch.active_until = body.active_until || null

  const { data, error } = await sb
    .from('portal_announcements')
    .update(patch)
    .eq('id', params.id)
    .select('id, title, message, title_en, message_en, type, active, dismissible, active_from, active_until, created_at, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ announcement: data })
}

/**
 * DELETE /api/crm/portal-announcements/[id]
 * Hard delete — announcements are admin-only records with no client audit trail.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAdmin()
  if (auth) return auth

  const { error } = await sb
    .from('portal_announcements')
    .delete()
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true })
}
