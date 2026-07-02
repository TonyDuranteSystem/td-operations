import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { validateDesignAsset } from '@/lib/td-communication/design-assets'

export const dynamic = 'force-dynamic'

const BUCKET = 'td-comm-deliverables'

/**
 * POST /api/td-communication/projects/[id]/design-assets/upload-url
 *
 * Short-lived signed upload URL for a DESIGN-TOOL output (mockup PNG / asset-kit
 * ZIP), scoped to the enrollment folder. Isolated from the deliverables upload
 * route: its own allow-list (png/zip) so the shared deliverables validation is
 * untouched. Staff or scoped partner.
 *
 * Body: { file_name, type } → { signedUrl, token, path }
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
  const fileName = typeof body.file_name === 'string' ? body.file_name : null
  const type = body.type
  if (!fileName) return NextResponse.json({ error: 'file_name is required.' }, { status: 400 })

  const validationError = validateDesignAsset(fileName, 0, type)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: enr } = await (supabaseAdmin as any)
    .from('td_comm_enrollments')
    .select('id')
    .eq('id', params.id)
    .maybeSingle()
  if (!enr) return NextResponse.json({ error: 'Project not found.' }, { status: 404 })

  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  const path = `${params.id}/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error('Design-asset signed-URL error:', error)
    return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
