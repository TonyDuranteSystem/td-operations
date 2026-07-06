import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveCommParticipant } from '@/lib/td-communication/queries'
import { validateSocialKitZip } from '@/lib/td-communication/social-kit'

export const dynamic = 'force-dynamic'

const BUCKET = 'td-comm-deliverables'

/**
 * POST /api/td-communication/projects/[id]/social-kit/upload-url
 *
 * Short-lived signed upload URL for the CLIENT-FACING social-kit ZIP, scoped to
 * the enrollment folder. Isolated from the Phase 12 design-assets upload route
 * (its own zip-only allow-list) so that path stays untouched. Staff or scoped
 * partner.
 *
 * Body: { file_name } → { signedUrl, token, path }
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
  if (!fileName) return NextResponse.json({ error: 'file_name is required.' }, { status: 400 })

  const validationError = validateSocialKitZip(fileName, 0)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: enr } = await (supabaseAdmin as any)
    .from('td_comm_enrollments')
    .select('id')
    .eq('id', params.id)
    .maybeSingle()
  if (!enr) return NextResponse.json({ error: 'Project not found.' }, { status: 404 })

  const path = `${params.id}/${randomUUID()}.zip`

  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error('Social-kit signed-URL error:', error)
    return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
