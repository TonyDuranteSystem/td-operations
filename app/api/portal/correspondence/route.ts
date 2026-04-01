/**
 * GET /api/portal/correspondence
 * Returns all correspondence for the logged-in client.
 * Contact-centric: returns correspondence for their contact + all linked accounts.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked' }, { status: 403 })

  const accountIds = await getClientAccountIds(contactId)

  // Fetch all correspondence: direct contact OR any linked account
  const { data, error } = await supabaseAdmin
    .from('client_correspondence')
    .select('id, file_name, description, drive_file_id, drive_file_url, read_at, created_at, account_id, contact_id')
    .or([
      `contact_id.eq.${contactId}`,
      accountIds.length > 0 ? `account_id.in.(${accountIds.join(',')})` : null,
    ].filter(Boolean).join(','))
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ correspondence: data ?? [] })
}
