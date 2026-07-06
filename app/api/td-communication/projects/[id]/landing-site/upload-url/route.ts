import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveCommParticipant } from '@/lib/td-communication/queries'

export const dynamic = 'force-dynamic'

/** Landing images render in a public <img> — safe raster formats only (no SVG: active content). */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

/**
 * POST /api/td-communication/projects/[id]/landing-site/upload-url
 *
 * Short-lived signed upload URL so the browser uploads a landing image (logo or
 * gallery) DIRECTLY into the PUBLIC `assets` bucket under client-landing/. The
 * public page is unauthenticated + cacheable, so its images must be public URLs
 * (getPublicUrl) — matching the origin the sanitizer pins to. Staff or scoped
 * partner.
 *
 * Body: { file_name } → { signedUrl, token, path, publicUrl }
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

  const ext = (fileName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  if (!IMAGE_EXTS.has(ext)) {
    return NextResponse.json({ error: 'Please upload an image (PNG, JPG, WEBP or GIF).' }, { status: 400 })
  }

  // Confirm the project exists (defense in depth; the id is trusted via the participant gate).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: enr } = await (supabaseAdmin as any)
    .from('td_comm_enrollments')
    .select('id')
    .eq('id', params.id)
    .maybeSingle()
  if (!enr) return NextResponse.json({ error: 'Project not found.' }, { status: 404 })

  const storagePath = `client-landing/${params.id}/${randomUUID()}.${ext}`
  const { data, error } = await supabaseAdmin.storage.from('assets').createSignedUploadUrl(storagePath)
  if (error || !data) {
    console.error('Client-landing signed-URL error:', error)
    return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  }
  const { data: urlData } = supabaseAdmin.storage.from('assets').getPublicUrl(storagePath)
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path: storagePath, publicUrl: urlData.publicUrl })
}
