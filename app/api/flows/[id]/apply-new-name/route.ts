/**
 * Company Change Name — "Apply the new name" (staff only).
 *
 * GET  /api/flows/[id]/apply-new-name → { success, state } what the panel shows (current name, filed name, what still blocks it).
 * POST /api/flows/[id]/apply-new-name → { new_name, confirm_mismatch? } renames the company + moves its old folders in ONE transaction
 *      (lib/operations/change-name-apply.ts). [id] = service_delivery_id.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { applyNewName, getApplyNameState } from '@/lib/operations/change-name-apply'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const state = await getApplyNameState(params.id)
  if (!state.ok) return NextResponse.json({ success: false, error: state.error }, { status: 404 })
  return NextResponse.json({ success: true, state })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  if (typeof body.new_name !== 'string') return NextResponse.json({ success: false, error: 'new_name must be text.' }, { status: 400 })

  const who = (user.user_metadata?.full_name as string | undefined) || (user.email as string | undefined) || 'staff'
  const result = await applyNewName({ sdId: params.id, typedName: body.new_name, confirmMismatch: body.confirm_mismatch === true, actorId: user.id, actorLabel: who })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error, mismatch: result.mismatch ?? null }, { status: 400 })
  return NextResponse.json({ success: true, result })
}
