import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { validateDesignAsset } from '@/lib/td-communication/design-assets'
import { insertDesignAsset } from '@/lib/td-communication/design-assets-queries'
import type { DesignAssetType } from '@/lib/td-communication/deliverables'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/projects/[id]/design-assets
 *
 * Records a saved design-tool output (mockup / asset_kit) as a deliverable row —
 * via the ISOLATED path that does NOT auto-advance the pipeline (no reveal
 * trigger). Staff or scoped partner. The file must already be uploaded to the
 * enrollment folder via the sibling upload-url route.
 *
 * Body: { type, file_url, file_name, file_size?, mime_type? } → { id }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const type = body.type
  const fileUrl = typeof body.file_url === 'string' ? body.file_url : null
  const fileName = typeof body.file_name === 'string' ? body.file_name : null
  const fileSize = typeof body.file_size === 'number' ? body.file_size : null
  const mimeType = typeof body.mime_type === 'string' ? body.mime_type : null

  if (!fileName) return NextResponse.json({ error: 'file_name is required.' }, { status: 400 })
  if (!fileUrl) return NextResponse.json({ error: 'file_url is required.' }, { status: 400 })
  // Guard against recording a path outside this enrollment's folder.
  if (!fileUrl.startsWith(`${params.id}/`)) {
    return NextResponse.json({ error: 'Invalid file path for this project.' }, { status: 400 })
  }
  const validationError = validateDesignAsset(fileName, fileSize ?? 0, type)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  try {
    const { id } = await insertDesignAsset(params.id, {
      type: type as DesignAssetType,
      file_url: fileUrl,
      file_name: fileName,
      file_size: fileSize,
      mime_type: mimeType,
    })
    return NextResponse.json({ id })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save the design asset.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
