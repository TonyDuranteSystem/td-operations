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

const ACTIONS: NameAction[] = ['mark_available', 'mark_not_available', 'send_to_client', 'mark_filed', 'mark_sos_rejected']

async function requireStaff() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { user: null, error: 'Unauthorized', status: 401 }
  const role = (user.app_metadata as Record<string, unknown> | undefined)?.role
  if (role === 'client') return { user: null, error: 'Staff access required', status: 403 }
  return { user, error: null, status: 200 }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff()
  if (!auth.user) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

  const name_checks = await getOrInitNameChecks(params.id)
  return NextResponse.json({ success: true, name_checks })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff()
  if (!auth.user) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

  const body = await req.json().catch(() => ({}))
  const action = body.action as NameAction
  const nameIndex = typeof body.name_index === 'number' ? body.name_index : NaN

  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 })
  }
  if (!Number.isInteger(nameIndex) || nameIndex < 0) {
    return NextResponse.json({ success: false, error: 'name_index must be a non-negative integer.' }, { status: 400 })
  }

  const who = (auth.user.user_metadata?.full_name as string | undefined)
    || (auth.user.email as string | undefined)
    || 'staff'

  const result = await handleNameAction({ sdId: params.id, action, nameIndex, actor: who, actorId: auth.user.id })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, name_checks: result.name_checks })
}
