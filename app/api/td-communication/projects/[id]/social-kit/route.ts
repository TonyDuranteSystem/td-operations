import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { validateSocialKitZip } from '@/lib/td-communication/social-kit'
import { insertClientSocialKit, listReleasedSocialKits } from '@/lib/td-communication/social-kit-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/projects/[id]/social-kit
 *
 * Released social kits for this project (newest first), with signed download URLs.
 * Staff or scoped partner — powers the "already sent to client" state in the tool.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const kits = await listReleasedSocialKits(params.id)
    return NextResponse.json({ kits })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load social kits.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST /api/td-communication/projects/[id]/social-kit
 *
 * Records a generated social-kit ZIP as a RELEASED, client-facing deliverable —
 * via the isolated path that does NOT advance the pipeline (no reveal trigger).
 * The zip must already be uploaded to the enrollment folder via the sibling
 * upload-url route. Staff or scoped partner.
 *
 * Body: { file_url, file_name, file_size?, mime_type? } → { id }
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
  const validationError = validateSocialKitZip(fileName, fileSize ?? 0)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  try {
    const { id } = await insertClientSocialKit(
      params.id,
      { file_url: fileUrl, file_name: fileName, file_size: fileSize, mime_type: mimeType },
      participant.name || participant.id,
    )
    return NextResponse.json({ id })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save the social sharing kit.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
