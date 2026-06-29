import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { listDeliverables, createDeliverable } from '@/lib/td-communication/deliverables-queries'
import { isDeliverableType, validateDeliverable } from '@/lib/td-communication/deliverables'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/projects/[id]/deliverables — list active
 * deliverables for an enrollment (signed preview + download URLs attached).
 * Staff or scoped partner.
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
    const deliverables = await listDeliverables(params.id)
    return NextResponse.json({ deliverables })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load deliverables.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST /api/td-communication/projects/[id]/deliverables — record a deliverable
 * AFTER its bytes were uploaded to storage via the upload-url route. Body:
 * { type, file_url, file_name, file_size?, mime_type?, concept_number? }.
 * Version number is assigned server-side. Staff or scoped partner.
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
  const conceptNumber = typeof body.concept_number === 'number' ? body.concept_number : undefined

  if (!isDeliverableType(type)) {
    return NextResponse.json({ error: 'Invalid deliverable type.' }, { status: 400 })
  }
  if (!fileName) return NextResponse.json({ error: 'file_name is required.' }, { status: 400 })
  if (!fileUrl) return NextResponse.json({ error: 'file_url is required.' }, { status: 400 })
  // Guard against recording a path outside this enrollment's folder.
  if (!fileUrl.startsWith(`${params.id}/`)) {
    return NextResponse.json({ error: 'Invalid file path for this project.' }, { status: 400 })
  }
  // Re-validate name + size server-side (defense in depth).
  const validationError = validateDeliverable(fileName, fileSize ?? 0)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  try {
    const deliverable = await createDeliverable(params.id, {
      type,
      file_url: fileUrl,
      file_name: fileName,
      file_size: fileSize,
      mime_type: mimeType,
      concept_number: conceptNumber,
    })
    return NextResponse.json({ deliverable })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save the deliverable.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
