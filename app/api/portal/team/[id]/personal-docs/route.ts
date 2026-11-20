/**
 * POST /api/portal/team/[id]/personal-docs — an owner or member shares (or stops sharing) THEIR OWN personal documents with one team login
 * (Team Powers step 7).   body: { account_id, enabled, notice_accepted?, notice_version?, notice_text?, owner_password? }
 *
 * Who: an owner or member of the company (assertAccountAdmin). The owner whose papers are shared is ALWAYS the signed-in person, never
 * anything in the request, so nobody can share a co-owner's documents. Switching ON needs the notice accepted word for word and the owner's
 * password in the same request (without them: 409 { needs_confirmation: true }); switching OFF needs nothing.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { assertAccountAdmin } from '@/lib/portal/team/server'
import { ownerActorFromRequest } from '@/lib/portal/team/events'
import { ownerNoticeLang } from '@/lib/portal/team/confirm-request'
import { checkNoticeAcceptance, verifyOwnerPassword, type Confirmation } from '@/lib/portal/team/confirm'
import { buildPersonalDocsNotice } from '@/lib/portal/team/personal-docs-notice'
import { setPersonalDocShare } from '@/lib/portal/team/personal-docs-share'
import { shareDeps } from '@/lib/portal/team/personal-docs-server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const accountId = String(body.account_id ?? '')
  const ownerContactId = await assertAccountAdmin(user, accountId)
  if (!ownerContactId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'Say whether to share or stop sharing.' }, { status: 400 })

  const actor = ownerActorFromRequest(ownerContactId, request.headers)

  // Switching ON: check the owner's confirmation now (the notice is built here from the same facts the screen used).
  let confirmation: Confirmation | null = null
  if (body.enabled === true && (body.notice_accepted !== undefined || body.owner_password !== undefined)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as any
    const { data: member } = await sb.from('portal_team_members').select('display_name').eq('id', params.id).eq('account_id', accountId).maybeSingle()
    if (!member) return NextResponse.json({ error: 'Team member not found.' }, { status: 404 })
    const { data: account } = await sb.from('accounts').select('company_name').eq('id', accountId).maybeSingle()
    if (!account) return NextResponse.json({ error: 'Company not found.' }, { status: 404 })

    const expected = buildPersonalDocsNotice({ lang: ownerNoticeLang(user), memberName: member.display_name as string, companyName: account.company_name as string })
    const accepted = checkNoticeAcceptance(body, expected, actor.ip ?? null)
    if (accepted.ok === false) return NextResponse.json({ error: accepted.error }, { status: accepted.status })
    const pw = await verifyOwnerPassword({ userId: user.id, email: user.email, password: body.owner_password })
    if (pw.ok === false) return NextResponse.json({ error: pw.error }, { status: pw.status })
    confirmation = accepted.confirmation
  }

  const result = await setPersonalDocShare(
    { teamMemberId: params.id, accountId, ownerContactId, enabled: body.enabled, confirmation, ip: actor.ip ?? null },
    shareDeps(),
  )
  if (result.ok === false) {
    return NextResponse.json({ error: result.error, ...(result.needsConfirmation ? { needs_confirmation: true } : {}) }, { status: result.status })
  }
  return NextResponse.json({ ok: true, changed: result.changed })
}
