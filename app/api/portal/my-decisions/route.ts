/**
 * GET /api/portal/my-decisions — the signed-in client's PENDING decision
 * requests across all flows. Powers the portal dashboard action items.
 * Returns [] for staff / users with no contact.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { listPendingDecisionsForContact } from '@/lib/operations/decision-request'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ success: true, requests: [] })

  const requests = await listPendingDecisionsForContact(contactId)
  return NextResponse.json({ success: true, requests })
}
