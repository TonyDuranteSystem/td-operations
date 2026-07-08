import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { channelSlug, validateHexColor } from '@/lib/team/workspace'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/channels
 * Create a team channel. Any staff member may create one. Body:
 *   { name, description?, color? }
 * Slug is derived from the name and must be unique (partial-unique index).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const name: string = (body.name ?? '').trim()
  const description: string | null = (body.description ?? '').trim() || null
  const color: string | null = (body.color ?? '').trim() || null

  if (!name) {
    return NextResponse.json({ error: 'Channel name is required.' }, { status: 400 })
  }
  const slug = channelSlug(name)
  if (!slug) {
    return NextResponse.json({ error: 'Channel name must contain letters or numbers.' }, { status: 400 })
  }
  const colorErr = validateHexColor(color ?? '')
  if (colorErr) return NextResponse.json({ error: colorErr }, { status: 400 })

  // Reject a duplicate slug up-front with a friendly message (the unique index is
  // the real guard, but this gives a clean error instead of a 500).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id')
    .eq('channel_slug', slug)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ error: `A channel "#${slug}" already exists.` }, { status: 409 })
  }

  const now = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread, error } = await (supabaseAdmin as any)
    .from('internal_threads')
    .insert({
      thread_type: 'channel',
      channel_name: name,
      channel_slug: slug,
      description,
      color,
      title: name,
      created_by: user.id,
      last_activity_at: now,
    })
    .select()
    .single()

  if (error) {
    // 23505 = unique_violation (slug race).
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: `A channel "#${slug}" already exists.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Seed a system first message so the channel isn't empty.
  await supabaseAdmin.from('internal_messages').insert({
    thread_id: thread.id,
    sender_id: user.id,
    sender_name: getUserDisplayName(user),
    message: `Created #${slug}.`,
    read_at: now,
  })

  return NextResponse.json({ thread })
}
