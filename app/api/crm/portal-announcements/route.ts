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
 * GET /api/crm/portal-announcements
 * Returns all announcements (active + inactive) for the admin config UI.
 */
export async function GET() {
  const auth = await requireAdmin()
  if (auth) return auth

  try {
    const { data, error } = await sb
      .from('portal_announcements')
      .select('id, title, message, title_en, message_en, type, active, dismissible, created_at, updated_at')
      .order('created_at', { ascending: false })

    if (error) return NextResponse.json({ announcements: [] })
    return NextResponse.json({ announcements: data ?? [] })
  } catch {
    return NextResponse.json({ announcements: [] })
  }
}

/**
 * POST /api/crm/portal-announcements
 * Creates a new portal announcement.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth) return auth

  const body = await request.json().catch(() => null) as {
    title?: string
    message?: string
    title_en?: string | null
    message_en?: string | null
    type?: string
    dismissible?: boolean
    active?: boolean
  } | null

  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  if (!body.title?.trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })
  if (!body.message?.trim()) return NextResponse.json({ error: 'message required' }, { status: 400 })

  const validTypes = ['info', 'warning', 'success']
  const type = validTypes.includes(body.type ?? '') ? body.type : 'info'

  const { data, error } = await sb
    .from('portal_announcements')
    .insert({
      title: body.title.trim(),
      message: body.message.trim(),
      title_en: body.title_en?.trim() || null,
      message_en: body.message_en?.trim() || null,
      type,
      dismissible: body.dismissible !== false,
      active: body.active !== false,
    })
    .select('id, title, message, title_en, message_en, type, active, dismissible, created_at, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ announcement: data }, { status: 201 })
}
