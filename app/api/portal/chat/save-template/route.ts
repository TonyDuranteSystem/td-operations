import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/save-template
 * Saves an admin chat reply as an approved response template.
 * Deduplicates on first 80 chars of response_text.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const { message_text, title } = await request.json()
  if (!message_text?.trim()) return NextResponse.json({ error: 'message_text required' }, { status: 400 })
  if (!title?.trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })

  // Check for a near-duplicate (same first 80 chars of response_text)
  const fingerprint = message_text.trim().slice(0, 80)
  const { data: existing } = await supabaseAdmin
    .from('approved_responses')
    .select('id, title')
    .ilike('response_text', `${fingerprint}%`)
    .limit(1)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ duplicate: true, existing_title: existing.title }, { status: 409 })
  }

  const { data, error } = await supabaseAdmin
    .from('approved_responses')
    .insert({
      title: title.trim(),
      response_text: message_text.trim(),
      category: 'Chat Response',
      usage_count: 0,
    })
    .select('id, title')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ saved: true, id: data.id, title: data.title })
}
