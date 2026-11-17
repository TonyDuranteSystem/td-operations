import { createClient } from '@/lib/supabase/server'
import { logPortalAction, PortalAction } from '@/lib/portal/audit'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { auditAccountIdFor } from '@/lib/portal/audit-scope'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/audit
 * Logs a portal action from the client-side.
 * Body: { action: string, detail?: string, account_id?: string }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false }, { status: 401 })

  try {
    const { action, detail, account_id } = await request.json()

    const validActions: PortalAction[] = [
      'login', 'password_change', 'language_changed', 'account_switched',
      'settings_changed', 'document_downloaded',
    ]

    if (!validActions.includes(action)) {
      return NextResponse.json({ ok: false }, { status: 400 })
    }

    // File the line under a company this login actually belongs to — never the one the browser names
    // unless it is one of the login's own (a team login always gets its one company).
    const identity = await resolvePortalIdentity(user)
    const isStaff = (user.app_metadata as Record<string, unknown> | undefined)?.role !== 'client'
    const resolvedAccountId = auditAccountIdFor(identity, account_id, isStaff)

    logPortalAction({
      user_id: user.id,
      account_id: resolvedAccountId,
      action,
      detail: detail?.slice(0, 500),
      ip: request.headers.get('x-forwarded-for') || undefined,
    })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
}
