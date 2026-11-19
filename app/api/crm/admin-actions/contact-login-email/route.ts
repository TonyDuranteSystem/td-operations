import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { staffChangeLoginEmail, viewStaffLogin } from '@/lib/portal/login-email-change-staff'
import { isFailure } from '@/lib/portal/login-email-change'

/**
 * Staff changes a client's PORTAL LOGIN email (dev job beb43385, step 3). Admin-only, like the other contact-portal actions.
 *   GET  ?contact_id=…            → what the dialog shows: the real login email (found by the contact id), or why there is none
 *   POST { contact_id, new_email } → change it right away (no code); both addresses are told. Body has no password: staff are signed in.
 * Reasons for a refusal come back in plain English in `error` (staff may see who owns an email; the client never does).
 */
async function requireAdmin() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isAdmin(user)) return null
  return user
}

export async function GET(request: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  const view = await viewStaffLogin(request.nextUrl.searchParams.get('contact_id'))
  return NextResponse.json(view)
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const actor = `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`
  const result = await staffChangeLoginEmail({ contactId: body?.contact_id, newEmail: body?.new_email, actor })

  if (isFailure(result)) {
    const status = result.code === 'failed' ? 500 : result.code === 'no_contact' ? 404 : 400
    return NextResponse.json({ ok: false, code: result.code, error: result.message }, { status })
  }
  return NextResponse.json({
    ok: true,
    old_email: result.oldEmail,
    new_email: result.newEmail,
    notice_to_new: result.noticeToNew,
    notice_to_old: result.noticeToOld,
  })
}
