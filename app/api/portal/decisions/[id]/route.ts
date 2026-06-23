/**
 * GET /api/portal/decisions/[id] — fetch one decision request.
 * Staff see any request; a client sees only their own (contact-scoped, or via
 * 'documents' access to the request's account). Default-deny.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { getDecisionRequest } from '@/lib/operations/decision-request'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const request = await getDecisionRequest(params.id)
  if (!request) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const role = (user.app_metadata as Record<string, unknown> | undefined)?.role
  if (role !== 'client') {
    return NextResponse.json({ success: true, request }) // staff
  }

  // Client — must own the request.
  const contactId = getClientContactId(user)
  const ownsContact = !!request.contact_id && !!contactId && request.contact_id === contactId
  const ownsAccount = request.account_id ? await canAccessAccount(user, request.account_id, 'documents') : false
  if (!ownsContact && !ownsAccount) {
    return NextResponse.json({ success: false, error: 'Access denied' }, { status: 403 })
  }
  return NextResponse.json({ success: true, request })
}
