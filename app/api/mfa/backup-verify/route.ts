/**
 * POST /api/mfa/backup-verify — one-shot backup-code recovery (dev job de4564ee).
 *
 * Council-fixed semantics (Architect blocker): a backup code is RECOVERY,
 * never a login method. A valid code deletes the user's TOTP factors and
 * purges all remaining codes; the factor deletion signs the user out of
 * every session (SDK behavior), so they land at login → password → forced
 * fresh enrollment (new factor + new codes). No remember-device cookie, no
 * session trust is ever minted here.
 *
 * This path is EXEMPT from the middleware MFA verdict (a phone-lost staff
 * member is aal1 by definition — Bug Hunter blocker) but still requires a
 * valid staff session. Rate-limited; single-use enforced by conditional
 * UPDATE (TOCTOU pattern).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isStaffAuthRole } from '@/lib/team/workspace'
import { hashBackupCode } from '@/lib/auth/mfa-backup-codes'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const limit = checkRateLimit(getRateLimitKey(req), 10, 60_000)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 })
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffAuthRole(user.app_metadata?.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { code } = await req.json().catch(() => ({ code: null }))
  if (!code || typeof code !== 'string' || code.length > 64) {
    return NextResponse.json({ error: 'Invalid code.' }, { status: 400 })
  }

  // Single-use: conditional update, never read-then-write. (mfa_backup_codes
  // is absent from the generated DB types — regen blocked by the schema-drift
  // decision; established cast precedent.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: consumed } = await (supabaseAdmin as any)
    .from('mfa_backup_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('code_hash', hashBackupCode(code))
    .is('used_at', null)
    .select('id')
  if (!consumed || consumed.length === 0) {
    return NextResponse.json({ error: 'Invalid or already-used code.' }, { status: 403 })
  }

  // One-shot recovery: drop every TOTP factor (this also revokes all of the
  // user's sessions — including this one — per the SDK contract) and purge
  // remaining codes; fresh ones are generated at re-enrollment.
  const { data: factorList } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: user.id })
  for (const factor of factorList?.factors ?? []) {
    await supabaseAdmin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any).from('mfa_backup_codes').delete().eq('user_id', user.id)

  return NextResponse.json({ ok: true, reenroll: true })
}
