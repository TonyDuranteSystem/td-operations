/**
 * POST /api/mfa/exemption — the owner switches two-factor OFF (or back ON)
 * for HIS OWN account (Antonio, 2026-08-07: "in admin for
 * antonio.durante account I want complete control on everything").
 *
 * Why this exists: removing an authenticator alone does not keep MFA off —
 * once grace has passed the gate pushes the account straight back into
 * enrollment at the next login. This flag is the only thing the gate honours
 * as a durable "off".
 *
 * Hard limits, deliberately narrow:
 *  - Caller must be a PROTECTED ADMIN (the code-level owner allow-list, not a
 *    database role anyone could be granted) — `isSecureAdmin` alone is not
 *    enough, because a service-role write could mint an admin.
 *  - Caller may only ever target THEMSELVES. There is no userId parameter:
 *    the account is taken from the session. So this can never be used to
 *    weaken a staff member — those are reset from Team Management, which
 *    forces re-enrollment rather than exempting.
 *  - Turning the exemption ON also removes any authenticator, so the account
 *    state and the switch agree (an exempt account holding a live factor
 *    would still be challenged, which reads as a broken switch).
 *  - Every flip is written to the audit log.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isProtectedAdminEmail } from '@/lib/auth'
import { logAction } from '@/lib/mcp/action-log'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isProtectedAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const exempt = (body as { exempt?: unknown })?.exempt
  if (typeof exempt !== 'boolean') {
    return NextResponse.json({ error: 'exempt must be true or false' }, { status: 400 })
  }

  const { data: fresh } = await supabaseAdmin.auth.admin.getUserById(user.id)
  const current = fresh?.user?.app_metadata ?? {}

  if (exempt) {
    // Clear any authenticator + codes so "off" is actually off, and bump the
    // device-trust version so no stale trusted device lingers.
    const { data: factors } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: user.id })
    for (const f of factors?.factors ?? []) {
      await supabaseAdmin.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('mfa_backup_codes').delete().eq('user_id', user.id)
  }

  const version = (current.mfa_rd_version as number | undefined) ?? 0
  await supabaseAdmin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...current,
      mfa_exempt: exempt,
      mfa_rd_version: exempt ? version + 1 : version,
    },
  })

  logAction({
    actor: user.email ?? 'owner',
    action_type: exempt ? 'mfa_exemption_enabled' : 'mfa_exemption_disabled',
    table_name: 'auth.users',
    record_id: user.id,
    summary: exempt
      ? `Two-factor switched OFF (owner exemption) for ${user.email}`
      : `Two-factor requirement restored for ${user.email}`,
    details: { email: user.email, exempt },
  })

  return NextResponse.json({ ok: true, exempt })
}
