/**
 * POST /api/portal/decisions/[id]/respond — the client submits their answer.
 *
 * Portal auth: the signed-in user must own the request (contact-scoped, or
 * 'documents' access to the request's account). The response is validated
 * against the request type; double-answers are rejected (TOCTOU guard in the
 * operations helper).
 *
 * Body: { response } — shape depends on request_type.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { getDecisionRequest, respondToDecisionRequest } from '@/lib/operations/decision-request'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const request = await getDecisionRequest(params.id)
  if (!request) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Ownership — clients only respond to their own requests.
  const contactId = getClientContactId(user)
  const ownsContact = !!request.contact_id && !!contactId && request.contact_id === contactId
  const ownsAccount = request.account_id ? await canAccessAccount(user, request.account_id, 'documents') : false
  if (!ownsContact && !ownsAccount) {
    return NextResponse.json({ success: false, error: 'Access denied' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const result = await respondToDecisionRequest({
    id: params.id,
    rawResponse: body.response,
    respondedBy: user.id,
    actor: 'portal-client',
  })

  if (!result.ok) {
    // 409 for already-answered/expired; 400 for invalid response shape.
    const conflict = /already|expired|no longer active/i.test(result.error ?? '')
    return NextResponse.json({ success: false, error: result.error }, { status: conflict ? 409 : 400 })
  }
  return NextResponse.json({ success: true, status: result.status, auto_advanced: result.auto_advanced })
}
