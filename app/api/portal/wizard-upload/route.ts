/**
 * POST /api/portal/wizard-upload — Upload a file from the wizard to Supabase Storage
 * Uses the same bucket pattern as external forms: {wizard_type}-uploads/{identifier}/{filename}
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClient } from '@/lib/auth'

const BUCKET = 'onboarding-uploads' // Shared bucket for all wizard uploads

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const fieldName = formData.get('field_name') as string
    const wizardType = formData.get('wizard_type') as string
    const identifier = formData.get('identifier') as string || user.email || user.id

    if (!file || !fieldName) {
      return NextResponse.json({ error: 'file and field_name required' }, { status: 400 })
    }

    // Build storage path: {wizard_type}/{identifier}/{fieldName}_{filename}
    const sanitizedId = identifier.replace(/[^a-zA-Z0-9@._-]/g, '_')
    const storagePath = `${wizardType || 'wizard'}/${sanitizedId}/${fieldName}_${file.name}`

    // Upload to Supabase Storage
    const arrayBuffer = await file.arrayBuffer()
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, arrayBuffer, {
        contentType: file.type,
        upsert: true, // overwrite if same file uploaded again
      })

    if (uploadError) {
      console.error('[wizard-upload] Upload error:', uploadError.message)
      return NextResponse.json({ error: uploadError.message }, { status: 500 })
    }

    return NextResponse.json({ path: storagePath, bucket: BUCKET })
  } catch (err) {
    console.error('[wizard-upload] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
