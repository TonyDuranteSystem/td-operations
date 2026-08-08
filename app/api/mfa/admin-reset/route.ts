/**
 * POST /api/mfa/admin-reset — admin resets a staff member's MFA.
 * (dev job de4564ee)
 *
 * Security-blocker rules baked in:
 *  - Caller gate is isSecureAdmin (app_metadata.role / ADMIN_EMAILS ONLY —
 *    never user_metadata, which the account holder can edit themselves).
 *  - Protected admin accounts (ADMIN_EMAILS) can be reset by NO ONE but
 *    themselves — a compromised staff session must not be able to reset
 *    Antonio and take over his login.
 *  - Reset = delete every TOTP factor (the SDK signs the target out of ALL
 *    sessions on verified-factor deletion — killing exactly the stolen
 *    session a reset exists for) + purge backup codes + bump
 *    mfa_rd_version so every remember-device cookie dies.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isSecureAdmin, isProtectedAdminEmail } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user: caller } } = await supabase.auth.getUser()
  if (!caller || !isSecureAdmin(caller)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { userId } = await req.json().catch(() => ({ userId: null }))
  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId required' }, { status: 400 })
  }

  const { data: targetData, error: targetErr } = await supabaseAdmin.auth.admin.getUserById(userId)
  const target = targetData?.user
  if (targetErr || !target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }
  if (isProtectedAdminEmail(target.email) && target.id !== caller.id) {
    return NextResponse.json(
      { error: 'This account can only reset its own MFA.' },
      { status: 403 },
    )
  }

  const { data: factorList } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId })
  for (const factor of factorList?.factors ?? []) {
    await supabaseAdmin.auth.admin.mfa.deleteFactor({ id: factor.id, userId })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any).from('mfa_backup_codes').delete().eq('user_id', userId)

  // Bump the remember-device version — read-modify-write the full
  // app_metadata object rather than trusting shallow-merge semantics.
  const currentVersion = (target.app_metadata?.mfa_rd_version as number | undefined) ?? 0
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    app_metadata: { ...target.app_metadata, mfa_rd_version: currentVersion + 1 },
  })

  return NextResponse.json({
    ok: true,
    factorsDeleted: factorList?.factors?.length ?? 0,
  })
}
