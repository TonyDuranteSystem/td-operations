import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/save-template
 * Saves an admin chat reply as an approved response template.
 * Auto-detects service_type from the account's active services and
 * language from the primary contact. The caller provides the title
 * (pre-filled from first line of message, editable by the admin).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const { message_text, title, account_id, contact_id } = await request.json()
  if (!message_text?.trim()) return NextResponse.json({ error: 'message_text required' }, { status: 400 })
  if (!title?.trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })

  // Detect service_type from the account's first active service
  let serviceType: string | null = null
  let language: string | null = null

  if (account_id) {
    const { data: svc } = await supabaseAdmin
      .from('service_deliveries')
      .select('service_type')
      .eq('account_id', account_id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    serviceType = svc?.service_type ?? null

    // Language from primary contact
    const { data: primaryAc } = await supabaseAdmin
      .from('account_contacts')
      .select('contacts(language)')
      .eq('account_id', account_id)
      .eq('is_primary', true)
      .limit(1)
      .maybeSingle()
    const lang = (primaryAc?.contacts as { language?: string | null } | null)?.language
    language = lang ?? null
  } else if (contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('language')
      .eq('id', contact_id)
      .single()
    language = contact?.language ?? null
  }

  // Normalize language to match approved_responses convention
  if (language === 'it') language = 'Italian'
  if (language === 'en') language = 'English'

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
      service_type: serviceType as never,
      language,
      usage_count: 0,
    })
    .select('id, title')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ saved: true, id: data.id, title: data.title })
}
