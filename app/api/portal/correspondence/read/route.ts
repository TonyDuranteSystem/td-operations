/**
 * POST /api/portal/correspondence/read
 * Mark one or more correspondence items as read.
 * Body: { id: string } or { ids: string[] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked' }, { status: 403 })

  const body = await req.json()
  const ids: string[] = body.ids ?? (body.id ? [body.id] : [])
  if (!ids.length) return NextResponse.json({ error: 'id or ids required' }, { status: 400 })

  const accountIds = await getClientAccountIds(contactId)

  // Only mark as read if the client owns these records
  const { error } = await supabaseAdmin
    .from('client_correspondence')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)
    .is('read_at', null)
    .or([
      `contact_id.eq.${contactId}`,
      accountIds.length > 0 ? `account_id.in.(${accountIds.join(',')})` : null,
    ].filter(Boolean).join(','))

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
