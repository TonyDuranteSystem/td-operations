/**
 * POST /api/portal/member-info-form/request
 *
 * Client self-service entry point to the SAME member info form staff already
 * send (app/api/accounts/[id]/member-info-form). Reachable from the Generate
 * Documents screen: if the Manager name the system resolved for the
 * Operating Agreement doesn't look right, the fix is correcting the
 * underlying member records — never a name picker at generation time
 * (Antonio, dev job 9ad76300-6181-4250-a1de-c77f37933f82 / 9ad76300-6181-4250-a1de-c77f37933f82).
 *
 * Unlike the staff route, this does NOT send a portal chat message — the
 * requesting client is already in the portal and gets the form URL directly
 * to open right now. Idempotent with the staff path: both read/write the
 * same `member_info_requests` row via the shared helper, so a pending
 * request never gets duplicated regardless of who triggered it.
 *
 * ⚠️ KNOWN, DELIBERATELY UNRESOLVED SCOPE (Bug-Hunter pass, dev job 9ad76300-6181-4250-a1de-c77f37933f82):
 * access here is checked only against "is this contact linked to the
 * account at all" — the same standard every other portal action on an
 * account uses — NOT against "is this contact the account's flagged
 * signer/primary." That is intentional for now: the button exists
 * specifically for the case where the CURRENTLY resolved signer is wrong,
 * so requiring the requester to already BE the correctly-resolved signer
 * would lock out exactly the person most likely to need it. The real
 * unresolved question — should a minority co-owner be able to trigger a
 * correction to the WHOLE roster with no other owner's review — is a
 * business-policy call, not a code fix, and is not decided here. What IS
 * fixed: this is no longer silent. Every self-service request is logged to
 * the permanent audit trail AND reported so a human sees it, so if the
 * access model above turns out to be too permissive, there is a record to
 * catch it — not a blind spot.
 *
 * Body: { account_id: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { getOrCreateMemberInfoRequest } from '@/lib/members/member-info-request'
import { logAction } from '@/lib/mcp/action-log'
import { reportSystemError } from '@/lib/system-errors'

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked to your account' }, { status: 403 })

  let body: { account_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { account_id } = body
  if (!account_id) {
    return NextResponse.json({ error: 'account_id is required' }, { status: 400 })
  }

  const accessibleIds = await getClientAccountIds(contactId)
  if (!accessibleIds.includes(account_id)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const result = await getOrCreateMemberInfoRequest(account_id)
  if (result.outcome === 'error') {
    return NextResponse.json({ error: result.message }, { status: result.message === 'Account not found' ? 404 : 400 })
  }

  // Never silent — this hands out a live link that can rewrite the whole
  // member roster with no other review, so every self-service trigger goes
  // to the permanent audit trail AND to a human, regardless of who the
  // requester turns out to be.
  logAction({
    actor: 'portal-client',
    action_type: 'create',
    table_name: 'member_info_requests',
    record_id: account_id,
    account_id,
    contact_id: contactId,
    summary: `Client self-requested a member-info correction for account ${account_id} via the Generate Documents screen (${result.isExisting ? 'reused existing pending request' : 'new request'})`,
  })
  reportSystemError({
    source: 'server',
    route: '/api/portal/member-info-form/request',
    method: 'POST',
    message: `A client self-requested a member-info correction (Generate Documents screen) for account ${account_id}, contact ${contactId}. Not an error — informational, for staff visibility into who is correcting company ownership data.`,
    context: { account_id, contact_id: contactId, is_existing: result.isExisting },
  }).catch(() => {})

  return NextResponse.json({ form_url: result.formUrl, is_existing: result.isExisting })
}
