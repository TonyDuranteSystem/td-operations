import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePortfolioAccess } from '@/lib/td-communication/admin-auth'
import { getDeliverable } from '@/lib/td-communication/deliverables-queries'
import { copyDeliverableImageToPublic } from '@/lib/td-communication/copy-to-public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/admin/portfolio/copy-image — copy a RELEASED image
 * deliverable into the public assets bucket (portfolio/) and return its public URL
 * for use as a before/after image. canEdit (staff + scoped partner). Privacy:
 * copyDeliverableImageToPublic enforces released_at + image-only (a "before" from a
 * client's raw brief upload is NOT offered — the picker only lists released work).
 *
 * Body: { deliverable_id } → { publicUrl }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolvePortfolioAccess(user)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!access.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit the portfolio.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const deliverableId = typeof body.deliverable_id === 'string' ? body.deliverable_id : null
  if (!deliverableId) return NextResponse.json({ error: 'deliverable_id required' }, { status: 400 })

  let deliverable
  try {
    deliverable = await getDeliverable(deliverableId)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load the deliverable.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
  if (!deliverable) return NextResponse.json({ error: 'Deliverable not found.' }, { status: 404 })

  const result = await copyDeliverableImageToPublic(deliverable, 'portfolio')
  if (result.ok) return NextResponse.json({ publicUrl: result.publicUrl })
  return NextResponse.json({ error: result.error ?? 'Could not copy the image.' }, { status: result.status ?? 500 })
}
