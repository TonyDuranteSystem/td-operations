/**
 * Generate a signed upload URL for Supabase Storage.
 * Used by CRM document upload to bypass Vercel's 4.5MB body limit.
 *
 * POST { bucket, path, contentType }
 * Returns { signedUrl, path, token }
 *
 * STAFF ONLY, and pinned to a bucket + path allow-list (see
 * lib/storage/upload-guard.ts for the full rationale).
 *
 * This route used to hand a SERVICE-ROLE signed upload URL to anyone who could
 * name a bucket and a path. Middleware proves only that a session EXISTS — it
 * runs no role check for /api paths (isDashboardPath returns false for anything
 * under /api) — so a logged-in CLIENT portal user could obtain write access to
 * ANY bucket at ANY path: overwrite another client's signed contract, write into
 * the private worker-attachments bucket, and so on. Found by the 2026-07-20
 * council review (dev job 527b2377). The session check alone is NOT sufficient
 * here; keep both the isDashboardUser gate and the allow-list.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { validateStorageUploadTarget } from '@/lib/storage/upload-guard'

export async function POST(req: NextRequest) {
  try {
    // 1. Staff only. A client portal login is an authenticated user too, so the
    //    role check — not merely the presence of a session — is the control.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isDashboardUser(user)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))

    // 2. Pin the destination to the known dashboard callers' bucket + prefixes.
    const target = validateStorageUploadTarget(body)
    if (target.error) {
      return NextResponse.json({ error: target.error }, { status: target.status ?? 400 })
    }

    const { data, error } = await supabaseAdmin.storage
      .from(target.bucket)
      .createSignedUploadUrl(target.path)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      signedUrl: data.signedUrl,
      path: target.path,
      token: data.token,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
