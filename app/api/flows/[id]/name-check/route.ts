/**
 * Formation Name Command Center API. Staff-only (workspace).
 *
 * GET  /api/flows/[id]/name-check → { success, name_checks } (initialized from
 *      the formation wizard when the SD has none yet).
 * POST /api/flows/[id]/name-check → { action, name_index } applies a name status
 *      change; 'send_to_client' / 'mark_sos_rejected' also create the matching
 *      Client Decision Request. Returns the updated name_checks.
 *
 * [id] = service_delivery_id.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOrInitNameChecks, handleNameAction, type NameAction } from '@/lib/operations/formation-name-checks'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

const ACTIONS: NameAction[] = ['mark_available', 'mark_not_available', 'send_to_client', 'mark_filed', 'mark_sos_rejected', 'request_new_names']

/** Same identity resolution requireStaffRoute() just validated — used here only to attribute the action (actor/actorId), not to gate access. */
async function currentUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const name_checks = await getOrInitNameChecks(params.id)
  return NextResponse.json({ success: true, name_checks })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const user = await currentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const action = body.action as NameAction
  const nameIndex = typeof body.name_index === 'number' ? body.name_index : NaN

  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 })
  }
  // request_new_names is not tied to a specific candidate, so it needs no index.
  if (action !== 'request_new_names' && (!Number.isInteger(nameIndex) || nameIndex < 0)) {
    return NextResponse.json({ success: false, error: 'name_index must be a non-negative integer.' }, { status: 400 })
  }
  const idx = Number.isInteger(nameIndex) && nameIndex >= 0 ? nameIndex : 0

  const who = (user.user_metadata?.full_name as string | undefined)
    || (user.email as string | undefined)
    || 'staff'

  const result = await handleNameAction({ sdId: params.id, action, nameIndex: idx, actor: who, actorId: user.id })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, name_checks: result.name_checks })
}
