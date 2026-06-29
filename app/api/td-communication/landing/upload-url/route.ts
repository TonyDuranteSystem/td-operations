import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveLandingAccess } from '@/lib/td-communication/admin-auth'
import { randomUUID } from 'crypto'

export const dynamic = 'force-dynamic'

/** Portfolio images are shown publicly in an <img> — restrict to safe raster formats (no SVG: active content). */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

/**
 * POST /api/td-communication/landing/upload-url — short-lived signed upload URL
 * so the browser uploads a portfolio image DIRECTLY to Storage (bypassing the
 * serverless body limit). Lands in the PUBLIC `assets` bucket under
 * landing-portfolio/. Editor-gated (admin staff or scoped partner).
 *
 * Body: { file_name } → { signedUrl, token, path, publicUrl }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolveLandingAccess(user)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!access.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit the landing page.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const fileName = typeof body.file_name === 'string' ? body.file_name : null
  if (!fileName) return NextResponse.json({ error: 'file_name required' }, { status: 400 })

  const ext = (fileName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  if (!IMAGE_EXTS.has(ext)) {
    return NextResponse.json(
      { error: 'Please upload an image (PNG, JPG, WEBP or GIF).' },
      { status: 400 },
    )
  }

  const storagePath = `landing-portfolio/${randomUUID()}.${ext}`
  const { data, error } = await supabaseAdmin.storage.from('assets').createSignedUploadUrl(storagePath)
  if (error || !data) {
    console.error('Landing portfolio signed-URL error:', error)
    return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  }
  const { data: urlData } = supabaseAdmin.storage.from('assets').getPublicUrl(storagePath)

  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path: storagePath, publicUrl: urlData.publicUrl })
}
