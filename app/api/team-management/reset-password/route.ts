/**
 * POST /api/team-management/reset-password — an admin resets a STAFF member's
 * dashboard password. Body: { user_id }
 *
 * Generates a new temporary password, applies it, emails it to the member,
 * and returns it ONCE so the admin can hand it over if the email fails (the
 * original create flow had no way to recover from a lost or failed email).
 *
 * Security rules (same family as /api/mfa/admin-reset — this is an
 * account-takeover primitive, so it is deliberately strict):
 *  - Caller gate is isSecureAdmin (app_metadata.role / ADMIN_EMAILS only —
 *    never user_metadata, which the account holder can edit themselves).
 *  - Client and partner accounts are refused: this is the staff dashboard
 *    (a client's password is reset from the portal tooling).
 *  - Protected admin accounts (ADMIN_EMAILS) can be reset by no one else.
 *  - ADMIN accounts and OWNER accounts (Jodi) can only be reset by an OWNER —
 *    otherwise any admin could set a known password on an owner and walk into
 *    My Finances and the owner pages.
 *  - You cannot reset your own password here (use Change Password).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isSecureAdmin, isProtectedAdminEmail, isOwnerOnly, isOwnerEmail } from '@/lib/auth'
import { generateTempPassword, sendStaffCredentialsEmail } from '@/lib/auth/staff-credentials'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user: caller } } = await supabase.auth.getUser()
  if (!caller || !isSecureAdmin(caller)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403, headers: NO_STORE })
  }

  const { user_id } = await req.json().catch(() => ({ user_id: null }))
  if (!user_id || typeof user_id !== 'string') {
    return NextResponse.json({ error: 'user_id required' }, { status: 400, headers: NO_STORE })
  }
  if (user_id === caller.id) {
    return NextResponse.json(
      { error: 'Use Change Password (key icon in the left menu) for your own account.' },
      { status: 400, headers: NO_STORE },
    )
  }

  const { data: targetData, error: targetErr } = await supabaseAdmin.auth.admin.getUserById(user_id)
  const target = targetData?.user
  if (targetErr || !target || !target.email) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: NO_STORE })
  }
  if (target.app_metadata?.role === 'client' || target.app_metadata?.role === 'partner') {
    return NextResponse.json(
      { error: 'This is a client or partner account, not a team member.' },
      { status: 400, headers: NO_STORE },
    )
  }
  if (isProtectedAdminEmail(target.email)) {
    return NextResponse.json(
      { error: 'This account can only change its own password.' },
      { status: 403, headers: NO_STORE },
    )
  }

  if (
    (target.app_metadata?.role === 'admin' || isOwnerEmail(target.email)) &&
    !isOwnerOnly(caller)
  ) {
    return NextResponse.json(
      { error: 'Only an owner can reset an administrator’s password.' },
      { status: 403, headers: NO_STORE },
    )
  }

  const tempPassword = generateTempPassword()
  const fullName: string = target.user_metadata?.full_name || target.email.split('@')[0]

  // Read-modify-write the whole user_metadata object rather than trusting
  // shallow-merge semantics (same discipline as the MFA reset).
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
    password: tempPassword,
    user_metadata: { ...target.user_metadata, must_change_password: true },
  })
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500, headers: NO_STORE })
  }

  const role = target.app_metadata?.role === 'admin' ? 'admin' : 'team'
  const emailSent = await sendStaffCredentialsEmail({
    kind: 'reset',
    fullName,
    email: target.email,
    tempPassword,
    role,
  })

  return NextResponse.json(
    { success: true, email: target.email, full_name: fullName, tempPassword, emailSent },
    { headers: NO_STORE },
  )
}
