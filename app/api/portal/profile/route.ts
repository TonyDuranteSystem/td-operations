import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/profile — Update client's contact info
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked' }, { status: 400 })

  const body = await request.json()
  const { contact_id, full_name, phone, language, citizenship, residency } = body

  // Verify the contact_id matches the user's contact
  if (contact_id !== contactId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const updates: Record<string, unknown> = {}
  if (full_name !== undefined) updates.full_name = full_name
  if (phone !== undefined) updates.phone = phone
  if (language !== undefined) updates.language = language
  if (citizenship !== undefined) updates.citizenship = citizenship
  if (residency !== undefined) updates.residency = residency
  updates.updated_at = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from('contacts')
    .update(updates)
    .eq('id', contactId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
