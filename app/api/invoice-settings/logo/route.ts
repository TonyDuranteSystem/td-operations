import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * POST /api/invoice-settings/logo
 * Upload company logo for invoices.
 * Body: multipart/form-data with `file` field
 * Returns: { url: string }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File must be under 2MB' }, { status: 400 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'Only JPEG, PNG, and WebP are allowed' }, { status: 400 })
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = EXT_MAP[file.type] || 'png'
    const storagePath = `company-logo.${ext}`

    // Remove old logos with different extensions
    const extensions = ['jpg', 'png', 'webp']
    for (const oldExt of extensions) {
      if (oldExt !== ext) {
        await supabaseAdmin.storage
          .from('public-assets')
          .remove([`company-logo.${oldExt}`])
      }
    }

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

    const logoUrl = urlData.publicUrl

    // Save URL to invoice_settings (single row)
    const { data: existing } = await supabaseAdmin
      .from('invoice_settings')
      .select('id')
      .limit(1)
      .single()

    if (existing) {
      const { error: updateError } = await supabaseAdmin
        .from('invoice_settings')
        .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (updateError) throw updateError
    }

    return NextResponse.json({ url: logoUrl })
  } catch (err) {
    console.error('Logo upload error:', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
