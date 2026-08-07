/**
 * POST /api/mfa/remember — mint the 30-day remember-device cookie.
 * (dev job de4564ee)
 *
 * Callable ONLY from an aal2 session (i.e. the caller just passed a real
 * TOTP verify — the browser client's cookies were rotated to aal2 before
 * this request). NOT exempt from the middleware gate: by the time it is
 * called legitimately, the gate already passes. The aal check here repeats
 * server-side anyway — defense in depth, and it keeps the cookie's one
 * honest meaning: "this device recently passed TOTP" (never enrollment,
 * never a backup code).
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaffAuthRole } from '@/lib/team/workspace'
import {
  signMfaRememberDevice,
  MFA_RD_COOKIE,
  MFA_RD_TTL_MS,
} from '@/lib/auth/mfa-remember-device'

export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffAuthRole(user.app_metadata?.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // aal from the SAME cookie session getUser() just validated (local decode).
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (aalData?.currentLevel !== 'aal2') {
    return NextResponse.json({ error: 'TOTP verification required.' }, { status: 403 })
  }

  const version = (user.app_metadata?.mfa_rd_version as number | undefined) ?? 0
  const token = await signMfaRememberDevice({ userId: user.id, version })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(MFA_RD_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(MFA_RD_TTL_MS / 1000),
  })
  return res
}
