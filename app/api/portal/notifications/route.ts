import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { decideNotificationOwnership, splitReadable, type OwnershipCaller } from '@/lib/portal/notification-read'
import { NextRequest, NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/portal/notifications?account_id=xxx&limit=20
 * GET /api/portal/notifications?contact_id=xxx&limit=20
 * POST /api/portal/notifications (mark as read) Body: { ids: [...] } — or { type: 'reaction', account_id? }
 * to clear the reaction notices when the client opens the chat. Must-act types (signature, form,
 * decision…) are never cleared here; the response lists what was `marked` and what was `skipped`.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account_id')
  const contactIdParam = searchParams.get('contact_id')
  const limit = Math.min(Number(searchParams.get('limit') ?? '20'), 50)

  if (!accountId && !contactIdParam) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  // Verify access. Gate on role==='client' (not contact-id presence) so a
  // teammate (client, no contact id) cannot skip the check.
  const isClientUser = user.app_metadata?.role === 'client'
  const authContactId = getClientContactId(user)
  if (isClientUser && !authContactId) {
    // Teammate (Portal Team Access): only their own account, only with 'announcements'.
    const tmAccountId = await getTeammateScopeOrNull(user, 'announcements')
    if (!tmAccountId || !accountId || accountId !== tmAccountId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  } else if (authContactId) {
    if (accountId) {
      const accountIds = await getClientAccountIds(authContactId)
      if (!accountIds.includes(accountId)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }
    if (contactIdParam && contactIdParam !== authContactId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  let dataQuery = supabaseAdmin
    .from('portal_notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  let countQuery = supabaseAdmin
    .from('portal_notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)

  // Scope the read.
  //
  // This used to be a strict either/or — `if (accountId) … else if (contactId)`
  // — which meant an active-tier client with a company selected NEVER saw their
  // person-scoped notifications. The portal layout always passes the selected
  // account, so for those clients the contact branch was unreachable. Measured
  // on production 2026-07-23 before the fix: 262 unread notifications hidden
  // from 55 clients — 128 chat alerts, 71 service updates, 51 form reminders
  // (chase-ups asking them to complete a form they were never shown), 5 decision
  // requests. Oldest April, newest the day before. The mark-as-read path below
  // already accepted BOTH scopes, which is what gives away that the either/or
  // was an oversight rather than a decision.
  //
  // SECURITY: the OR uses `authContactId` — derived server-side from the
  // session — never `contactIdParam`. A client passing someone else's contact
  // id is already rejected above, but this way the widened query cannot become
  // a hole even if that check is ever relaxed. Both halves are the caller's own
  // data: `accountId` is verified to be theirs, `authContactId` is them.
  //
  // A TEAMMATE (Portal Team Access, no contact id of their own) keeps the
  // account-only scope — they must not see the owner's personal notifications.
  //
  // Multi-company clients see the SELECTED company plus their personal items,
  // never another company's. That matches how the sidebar and chat already scope.
  // The personal half MUST also require account_id IS NULL. Most notifications
  // carry BOTH an account and a contact (39 of 56 for the QA fixture), so a bare
  // `contact_id.eq.X` matches every company's items for that person — selecting
  // company B would list company A's notifications. Caught in sandbox testing of
  // the first version of this fix, not in review. It is not a cross-client leak
  // (a foreign account_id is still rejected with 403 above), but it merges
  // companies, which is precisely the model the portal moved AWAY from when chat
  // was re-scoped per-company in 2026-06-24. "Personal" means addressed to the
  // person and tied to no company.
  if (accountId && authContactId) {
    const scope = `account_id.eq.${accountId},and(contact_id.eq.${authContactId},account_id.is.null)`
    dataQuery = dataQuery.or(scope)
    countQuery = countQuery.or(scope)
  } else if (accountId) {
    dataQuery = dataQuery.eq('account_id', accountId)
    countQuery = countQuery.eq('account_id', accountId)
  } else if (contactIdParam) {
    dataQuery = dataQuery.eq('contact_id', contactIdParam)
    countQuery = countQuery.eq('contact_id', contactIdParam)
  }

  const [{ data }, { count }] = await Promise.all([dataQuery, countQuery])

  return NextResponse.json({ notifications: data ?? [], unread_count: count ?? 0 })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only portal clients (and their teammates) own notifications. A staff login used to fall through
  // both checks below and run the UPDATE unscoped.
  if (user.app_metadata?.role !== 'client') {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  let body: { ids?: unknown; type?: unknown; account_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Who is asking. Teammate (Portal Team Access, no contact id): only their account, only with
  // 'announcements'. Everyone else is a client contact.
  const authContactId = getClientContactId(user)
  let caller: OwnershipCaller
  if (!authContactId) {
    const tmAccountId = await getTeammateScopeOrNull(user, 'announcements')
    if (!tmAccountId) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    caller = { kind: 'teammate', accountId: tmAccountId }
  } else {
    caller = { kind: 'client', contactId: authContactId, accountIds: await getClientAccountIds(authContactId) }
  }

  // Mode 2 — "I opened the chat": clear this scope's unread REACTION notices (and only those).
  if (body.type === 'reaction') {
    const accountId = typeof body.account_id === 'string' && body.account_id ? body.account_id : null
    if (accountId && (caller.kind === 'teammate' ? accountId !== caller.accountId : !caller.accountIds.includes(accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    let q = supabaseAdmin
      .from('portal_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('type', 'reaction')
      .is('read_at', null)
    if (accountId) q = q.eq('account_id', accountId)
    else if (caller.kind === 'client') q = q.eq('contact_id', caller.contactId).is('account_id', null)
    else return NextResponse.json({ success: true, marked: [], skipped: [] })
    const { error } = await q
    if (error) {
      console.error('[portal notifications] mark reactions read failed:', error.message)
      return NextResponse.json({ error: 'Could not update notifications — please try again.' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  }

  // Mode 1 — mark specific notifications read.
  const { ids } = body
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every(i => typeof i === 'string' && UUID_RE.test(i))) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })
  }

  const { data: rows, error: selErr } = await supabaseAdmin
    .from('portal_notifications')
    .select('id, account_id, contact_id, type')
    .in('id', ids)
  if (selErr) {
    console.error('[portal notifications] lookup failed:', selErr.message)
    return NextResponse.json({ error: 'Could not update notifications — please try again.' }, { status: 500 })
  }

  const decision = decideNotificationOwnership(ids, rows ?? [], caller)
  if (!decision.ok) return NextResponse.json({ error: decision.error ?? 'Access denied' }, { status: decision.status })

  // Things the client must DO stay unread until they are done.
  const { markable, skipped } = splitReadable(rows ?? [])
  if (markable.length > 0) {
    const markableIds = markable.map(r => r.id)
    const { error: updErr } = await supabaseAdmin
      .from('portal_notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', markableIds)
      .is('read_at', null)
    if (updErr) {
      console.error('[portal notifications] mark read failed:', updErr.message)
      return NextResponse.json({ error: 'Could not update notifications — please try again.' }, { status: 500 })
    }
  }

  return NextResponse.json({
    success: true,
    marked: markable.map(r => r.id),
    skipped: skipped.map(r => r.id),
  })
}
