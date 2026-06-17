import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { findAuthUsersByContactId } from '@/lib/auth-admin-helpers'
import { signViewAs, AUTH_TOKEN_TTL_MS } from '@/lib/portal/view-as'
import { PORTAL_BASE_URL } from '@/lib/config'

/**
 * POST /api/admin/view-as  — STAFF ONLY (admin or team — NOT clients).
 *
 * Step 1 of the read-only "View as client" flow. A dashboard user (admin or
 * staff) clicks the button on an account/contact page; this endpoint:
 *   1. verifies the caller is a dashboard user (admin or team, never a client),
 *   2. confirms the target contact has a CLIENT portal login,
 *   3. mints a short-lived signed authorization token, and
 *   4. returns the portal entry URL the browser opens in a new tab.
 *
 * It does NOT mint the client session — that happens on the portal domain in
 * GET /portal/view-as, so the admin's CRM session (a different domain) is never
 * touched. Returns { ok:false, reason:'no_login' } (HTTP 200) when the contact
 * has no portal login, so the UI can show a clean message.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isDashboardUser(user)) {
    return NextResponse.json({ ok: false, error: 'Staff only' }, { status: 403 })
  }

  let contactId: string | undefined
  try {
    const body = await req.json()
    contactId = typeof body?.contactId === 'string' ? body.contactId : undefined
  } catch {
    /* fall through to validation below */
  }
  if (!contactId) {
    return NextResponse.json({ ok: false, error: 'contactId required' }, { status: 400 })
  }

  // The contact must have a CLIENT auth user to view as.
  const authUsers = await findAuthUsersByContactId(contactId)
  const clientUser = authUsers.find((u) => u.app_metadata?.role === 'client')
  if (!clientUser) {
    return NextResponse.json({ ok: false, reason: 'no_login' })
  }

  const token = await signViewAs(
    { contactId, adminId: user!.id },
    AUTH_TOKEN_TTL_MS,
  )

  const url = `${PORTAL_BASE_URL}/portal/view-as?t=${encodeURIComponent(token)}`
  return NextResponse.json({ ok: true, url })
}
