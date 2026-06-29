import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveLandingAccess } from '@/lib/td-communication/admin-auth'
import { getDeliverable } from '@/lib/td-communication/deliverables-queries'
import { randomUUID } from 'crypto'

export const dynamic = 'force-dynamic'

const DELIVERABLES_BUCKET = 'td-comm-deliverables' // private
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

function extFor(fileName: string | null, mime: string | null): string {
  const fromName = (fileName?.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (IMAGE_EXTS.has(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg'
  return ''
}

/**
 * POST /api/td-communication/landing/portfolio-from-deliverable — copy a RELEASED
 * image deliverable out of the private td-comm-deliverables bucket into the public
 * `assets` bucket (landing-portfolio/), returning a public URL the editor drops
 * into a portfolio item. Lets Cris showcase work she already produced without
 * re-downloading/re-uploading. Editor-gated. Privacy: only released deliverables;
 * the editor still sets a public-safe client name + description.
 *
 * Body: { deliverable_id } → { publicUrl }
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
  if (!deliverable.released_at) {
    return NextResponse.json({ error: 'Only released deliverables can be shown in the portfolio.' }, { status: 400 })
  }
  if (!deliverable.file_url) {
    return NextResponse.json({ error: 'This deliverable has no file to copy.' }, { status: 400 })
  }
  const ext = extFor(deliverable.file_name, deliverable.mime_type)
  if (!ext) {
    return NextResponse.json({ error: 'Only image deliverables can be added to the portfolio.' }, { status: 400 })
  }

  // Download from the private bucket, re-upload to the public assets bucket.
  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(DELIVERABLES_BUCKET).download(deliverable.file_url)
  if (dlErr || !blob) {
    console.error('Landing portfolio copy — download error:', dlErr)
    return NextResponse.json({ error: 'Could not read the deliverable file.' }, { status: 500 })
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const contentType = deliverable.mime_type || `image/${ext === 'jpg' ? 'jpeg' : ext}`
  const destPath = `landing-portfolio/${randomUUID()}.${ext}`
  const { error: upErr } = await supabaseAdmin.storage.from('assets').upload(destPath, buffer, { contentType, upsert: false })
  if (upErr) {
    console.error('Landing portfolio copy — upload error:', upErr)
    return NextResponse.json({ error: 'Could not copy the image. Please try again.' }, { status: 500 })
  }
  const { data: urlData } = supabaseAdmin.storage.from('assets').getPublicUrl(destPath)
  return NextResponse.json({ publicUrl: urlData.publicUrl })
}
