import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { NextRequest, NextResponse } from 'next/server'

const MAX_SIZE = 2 * 1024 * 1024 // 2MB
// PNG and JPEG only: those are the two formats the invoice PDF can embed. WebP and SVG used to be accepted, then
// silently left off every PDF, and an SVG in a public bucket can carry scripts.
const ALLOWED_TYPES = ['image/jpeg', 'image/png']
const EXT_BY_TYPE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' }

/**
 * POST /api/portal/logo — Upload company logo for invoices
 * Body: multipart/form-data with file + account_id
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const accountId = formData.get('account_id') as string | null

  if (!file || !accountId) {
    return NextResponse.json({ error: 'file and account_id required' }, { status: 400 })
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'Logo must be under 2MB' }, { status: 400 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'Use a JPEG or PNG image' }, { status: 400 })
  }

  // Access control — default-deny (contacts AND teammates; never skipped).
  if (!(await canAccessAccount(user, accountId, 'company_services'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    // The browser-declared type is not proof: check the first bytes really are a PNG or a JPEG.
    const isPng = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const isJpg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    if ((file.type === 'image/png' && !isPng) || (file.type === 'image/jpeg' && !isJpg)) {
      return NextResponse.json({ error: 'That file is not a valid JPEG or PNG image' }, { status: 400 })
    }
    // Extension comes from the VALIDATED type, never from the file name the browser sent.
    const ext = EXT_BY_TYPE[file.type]
    const storagePath = `portal-logos/${accountId}.${ext}`

    // Upload to Supabase Storage (public bucket)
    const { error: uploadError } = await supabaseAdmin.storage
      .from('public-assets')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: true,
      })

    if (uploadError) {
      // Try creating bucket if it doesn't exist
      if (uploadError.message.includes('not found')) {
        await supabaseAdmin.storage.createBucket('public-assets', { public: true })
        const { error: retryError } = await supabaseAdmin.storage
          .from('public-assets')
          .upload(storagePath, buffer, { contentType: file.type, upsert: true })
        if (retryError) throw retryError
      } else {
        throw uploadError
      }
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from('public-assets')
      .getPublicUrl(storagePath)

    // A changed logo reuses the same file name, so add a version to the address or browsers show the old one.
    const logoUrl = `${urlData.publicUrl}?v=${Date.now()}`

    // Save URL to account
    // eslint-disable-next-line no-restricted-syntax -- pre-existing portal logo write; access now gated via canAccessAccount above
    const { error: saveErr } = await supabaseAdmin
      .from('accounts')
      .update({ invoice_logo_url: logoUrl })
      .eq('id', accountId)
    if (saveErr) throw saveErr

    return NextResponse.json({ success: true, url: logoUrl })
  } catch (err) {
    console.error('Logo upload error:', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
