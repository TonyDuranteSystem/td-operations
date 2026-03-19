import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']

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
    return NextResponse.json({ error: 'Use JPEG, PNG, WebP, or SVG' }, { status: 400 })
  }

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(accountId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = file.name.split('.').pop() || 'png'
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

    const logoUrl = urlData.publicUrl

    // Save URL to account
    await supabaseAdmin
      .from('accounts')
      .update({ invoice_logo_url: logoUrl })
      .eq('id', accountId)

    return NextResponse.json({ success: true, url: logoUrl })
  } catch (err) {
    console.error('Logo upload error:', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
