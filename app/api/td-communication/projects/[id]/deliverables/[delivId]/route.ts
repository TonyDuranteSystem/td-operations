import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import {
  getDeliverable,
  updateDeliverable,
  softDeleteDeliverable,
  type DeliverablePatch,
} from '@/lib/td-communication/deliverables-queries'
import { isDeliverableType } from '@/lib/td-communication/deliverables'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/td-communication/projects/[id]/deliverables/[delivId] — update a
 * deliverable. Body: { action: 'release' | 'release_final' | 'update', type?,
 * concept_number? }. Staff or scoped partner. Verifies the deliverable belongs
 * to the route's enrollment (no cross-project tampering).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; delivId: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const existing = await getDeliverable(params.delivId).catch(() => null)
  if (!existing || existing.enrollment_id !== params.id) {
    return NextResponse.json({ error: 'Deliverable not found.' }, { status: 404 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const action = body.action
  let patch: DeliverablePatch
  if (action === 'release') {
    patch = { action: 'release' }
  } else if (action === 'release_final') {
    patch = { action: 'release_final' }
  } else if (action === 'update') {
    if (body.type !== undefined && !isDeliverableType(body.type)) {
      return NextResponse.json({ error: 'Invalid deliverable type.' }, { status: 400 })
    }
    patch = {
      action: 'update',
      ...(isDeliverableType(body.type) ? { type: body.type } : {}),
      ...(typeof body.concept_number === 'number' ? { concept_number: body.concept_number } : {}),
    }
  } else {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }

  try {
    const deliverable = await updateDeliverable(params.delivId, patch, participant.name)
    return NextResponse.json({ deliverable })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update the deliverable.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * DELETE /api/td-communication/projects/[id]/deliverables/[delivId] —
 * soft-delete (R100). Staff or scoped partner; ownership verified.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; delivId: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const existing = await getDeliverable(params.delivId).catch(() => null)
  if (!existing || existing.enrollment_id !== params.id) {
    return NextResponse.json({ error: 'Deliverable not found.' }, { status: 404 })
  }

  try {
    await softDeleteDeliverable(params.delivId, participant.name)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete the deliverable.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
