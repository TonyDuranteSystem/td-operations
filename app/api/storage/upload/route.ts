/**
 * Generate a signed upload URL for Supabase Storage.
 * Used by CRM document upload to bypass Vercel's 4.5MB body limit.
 *
 * POST { bucket, path, contentType }
 * Returns { signedUrl }
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(req: NextRequest) {
  try {
    const { bucket, path } = await req.json()

    if (!bucket || !path) {
      return NextResponse.json({ error: 'Missing bucket or path' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUploadUrl(path)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      signedUrl: data.signedUrl,
      path,
      token: data.token,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
