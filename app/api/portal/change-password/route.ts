import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/change-password
 *
 * Sets the CALLER'S OWN password — the account is always resolved from the
 * session (supabase.auth.getUser()), never from anything client-supplied.
 *
 * This exists so the password-set/change action goes through OUR server
 * instead of the browser calling supabase.auth.updateUser() directly. A
 * direct browser call bypasses middleware.ts's "read-only view" lock entirely
 * (it never reaches our server), which is exactly how a real client's
 * password could get silently overwritten while a staff member was viewing
 * their account read-only (dev job 3d47f472, 2026-08-21: KS Media Consulting
 * LLC / Botond Dudas). Because this route lives under /api/portal/, it's
 * automatically covered by the existing lock in middleware.ts — no new
 * gating logic needed here.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const password = typeof body.password === 'string' ? body.password : ''
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    password,
    user_metadata: { ...user.user_metadata, must_change_password: false },
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Admin-driven password updates (unlike a user's own supabase.auth.updateUser())
  // invalidate the caller's existing session as a side effect. Return the email so
  // the client can immediately re-authenticate with the password it just set,
  // instead of landing back on the login screen right after success.
  return NextResponse.json({ success: true, email: user.email })
}
