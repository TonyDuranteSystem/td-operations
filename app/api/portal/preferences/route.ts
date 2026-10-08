import { createClient } from '@/lib/supabase/server'
import { setTourPref } from '@/lib/portal/guides/guides-server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * PUT /api/portal/preferences — remember a small per-login preference (today only tour.* keys, e.g.
 * { key: 'tour.invoicing', value: { status: 'completed' | 'dismissed', version } }).
 * Works for clients AND team members: it is keyed on the sign-in user, nothing company-specific.
 * Staff "view as" is read-only (the portal blocks writes there), so a staff member never saves a client's tour state.
 */
export async function PUT(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as { key?: unknown; value?: unknown }
  if (typeof body.key !== 'string') return NextResponse.json({ error: 'Missing key.' }, { status: 400 })

  const result = await setTourPref(user.id, body.key, body.value)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ success: true })
}
