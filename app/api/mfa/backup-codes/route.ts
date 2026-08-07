/**
 * POST /api/mfa/backup-codes — (re)generate the user's backup codes.
 * (dev job de4564ee)
 *
 * Called once at the end of enrollment (and only then, from the enroll
 * page, right after the first successful TOTP verify — so the session is
 * aal2). Returns the PLAIN codes exactly once; only hashes are stored.
 * Regenerating replaces all previous codes.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isStaffAuthRole } from '@/lib/team/workspace'
import { generateBackupCodes } from '@/lib/auth/mfa-backup-codes'

export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffAuthRole(user.app_metadata?.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (aalData?.currentLevel !== 'aal2') {
    return NextResponse.json({ error: 'TOTP verification required.' }, { status: 403 })
  }

  const { codes, hashes } = generateBackupCodes()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any).from('mfa_backup_codes').delete().eq('user_id', user.id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insertErr } = await (supabaseAdmin as any)
    .from('mfa_backup_codes')
    .insert(hashes.map(code_hash => ({ user_id: user.id, code_hash })))
  if (insertErr) {
    return NextResponse.json({ error: 'Could not store backup codes — try again.' }, { status: 500 })
  }

  // Plain codes leave the server exactly once, here.
  return NextResponse.json({ codes })
}
