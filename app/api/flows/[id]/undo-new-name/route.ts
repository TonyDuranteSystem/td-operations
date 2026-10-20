/**
 * Company Change Name — "Undo name change" (staff only).
 *
 * POST /api/flows/[id]/undo-new-name → puts the company's old name and its old folders back (one database transaction), only while the
 * job is on "Update our records" and the new folders are still empty (lib/operations/change-name-apply.ts, undoNewName).
 * [id] = service_delivery_id.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { undoNewName } from '@/lib/operations/change-name-apply'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const who = (user.user_metadata?.full_name as string | undefined) || (user.email as string | undefined) || 'staff'
  const result = await undoNewName({ sdId: params.id, actorId: user.id, actorLabel: who })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, result })
}
