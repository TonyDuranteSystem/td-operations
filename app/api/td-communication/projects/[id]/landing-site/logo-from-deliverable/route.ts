import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { getDeliverable } from '@/lib/td-communication/deliverables-queries'
import { copyDeliverableImageToPublic } from '@/lib/td-communication/copy-to-public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/projects/[id]/landing-site/logo-from-deliverable
 *
 * Copy a RELEASED image deliverable (e.g. the final logo) out of the private
 * td-comm-deliverables bucket into the PUBLIC `assets` bucket under client-landing/,
 * returning a public URL the editor sets as the theme logo (or a gallery image).
 * The public page can't use expiring signed URLs, so a copy is required. Reuses
 * the shared copyDeliverableImageToPublic helper. Staff or scoped partner.
 *
 * Body: { deliverable_id } → { publicUrl }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const deliverableId = typeof body.deliverable_id === 'string' ? body.deliverable_id : null
  if (!deliverableId) return NextResponse.json({ error: 'deliverable_id is required.' }, { status: 400 })

  let deliverable
  try {
    deliverable = await getDeliverable(deliverableId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load the deliverable.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
  if (!deliverable) return NextResponse.json({ error: 'Deliverable not found.' }, { status: 404 })
  // Ownership: the deliverable must belong to this project (no cross-project copy).
  if (deliverable.enrollment_id !== params.id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  const result = await copyDeliverableImageToPublic(deliverable, 'client-landing')
  if (result.ok) return NextResponse.json({ publicUrl: result.publicUrl })
  return NextResponse.json({ error: result.error ?? 'Could not copy the image.' }, { status: result.status ?? 500 })
}
