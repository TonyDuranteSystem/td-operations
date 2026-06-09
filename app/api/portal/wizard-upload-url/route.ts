/**
 * POST /api/portal/wizard-upload-url — Mint a short-lived signed upload URL so
 * the browser can upload a wizard file DIRECTLY to Supabase Storage, bypassing
 * this serverless function entirely.
 *
 * Why: the legacy /api/portal/wizard-upload route streamed the file through the
 * Vercel function, which caps request bodies at ~4.5MB — so larger bank
 * statements / merged PDFs failed. Direct-to-storage uploads have no such cap
 * (the bucket has no file_size_limit). dev_task 64bfcdd9.
 *
 * The storage path keeps the existing scheme so all downstream consumers still
 * match files by field name:
 *   {wizardType}/{identifier}/{fieldName}_{unique}_{filename}
 * The {unique} segment lets the same field hold multiple files without
 * colliding (multi-file support).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
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
    const body = await req.json()
    const fieldName = body.field_name as string
    const fileName = body.file_name as string
    const wizardType = body.wizard_type as string
    const identifier = (body.identifier as string) || user.email || user.id

    if (!fieldName || !fileName) {
      return NextResponse.json({ error: 'field_name and file_name are required' }, { status: 400 })
    }

    const sanitizedId = String(identifier).replace(/[^a-zA-Z0-9@._-]/g, '_')
    const sanitizedFile = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')
    const unique = randomUUID().slice(0, 8)
    const storagePath = `${wizardType || 'wizard'}/${sanitizedId}/${fieldName}_${unique}_${sanitizedFile}`

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath)

    if (error || !data) {
      console.error('[wizard-upload-url] createSignedUploadUrl error:', error?.message)
      return NextResponse.json({ error: error?.message || 'Could not create upload URL' }, { status: 500 })
    }

    return NextResponse.json({ path: storagePath, token: data.token, bucket: BUCKET })
  } catch (err) {
    console.error('[wizard-upload-url] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create upload URL' },
      { status: 500 },
    )
  }
}
