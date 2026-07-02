import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import {
  getDeliverableLogoSource,
  downloadDeliverableBytes,
} from '@/lib/td-communication/design-assets-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/projects/[id]/design-assets/logo-bytes?deliverableId=…
 *
 * Same-origin byte passthrough for a project's image deliverable, so the design
 * tools can draw it into a <canvas> WITHOUT tainting it (a cross-origin signed
 * URL taints the canvas and blocks toBlob for Export/Save). Mirrors the
 * documents/[id]/preview + portal/chat/attachment streaming pattern.
 *
 * Ownership-checked: the deliverable must belong to THIS enrollment (a
 * deliverableId from another project → 404, no IDOR). Staff or scoped partner.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const deliverableId = req.nextUrl.searchParams.get('deliverableId')
  if (!deliverableId) {
    return NextResponse.json({ error: 'deliverableId is required.' }, { status: 400 })
  }

  const source = await getDeliverableLogoSource(params.id, deliverableId)
  if (!source) return NextResponse.json({ error: 'Deliverable not found.' }, { status: 404 })

  const file = await downloadDeliverableBytes(source.file_url)
  if (!file) return NextResponse.json({ error: 'File not found.' }, { status: 404 })

  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': source.mime_type || file.contentType,
      'Content-Disposition': `inline; filename="${(source.file_name || 'logo').replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
