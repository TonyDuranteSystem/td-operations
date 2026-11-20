/**
 * POST /api/portal/team/accept-notice — a team login accepts its OWN notice (Team Powers step 6).
 *
 * Who: only a signed-in TEAM LOGIN (app metadata kind = team_member). The row is found from the signed-in person, never from
 * anything in the request, so nobody can accept for someone else. Body: { version } — the notice version the screen showed.
 * The words and version saved are built on the server (lib/portal/team/login-notice-accept.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getLocale } from '@/lib/portal/i18n'
import { isTeamLogin, teamMustChangePassword } from '@/lib/portal/team/password-flag'
import { acceptTeamLoginNotice } from '@/lib/portal/team/login-notice-accept'
import { acceptNoticeDeps } from '@/lib/portal/team/login-notice-server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Only a team login accepts this; owners and members accept their notices when they add someone.
  if (!isTeamLogin(user)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  // Still on the temporary password: choose a password first (the portal shows no data to this login yet).
  if (teamMustChangePassword(user)) return NextResponse.json({ error: 'Choose your own password first.' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() || null : null

  const result = await acceptTeamLoginNotice(
    { authUserId: user.id, lang: getLocale(user) === 'it' ? 'it' : 'en', shownVersion: body?.version, ip },
    acceptNoticeDeps(),
  )
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ success: true, alreadyAccepted: result.alreadyAccepted })
}
