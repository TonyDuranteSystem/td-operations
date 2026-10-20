/**
 * POST /api/tools/fax/upload-url — a signed direct-to-Storage upload address for a file to fax that is too big for the request body.
 * Staff only. Body: { file_name, file_size }. Answer: { signedUrl, token, path }. The send route is given `staged_path` = path.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { FAX_STAGING_BUCKET, faxStagingPathFor, faxSizeProblem } from '@/lib/fax/staged-upload'

export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const fileName = typeof body.file_name === 'string' ? body.file_name : ''
  const size = typeof body.file_size === 'number' ? body.file_size : 0
  if (!fileName) return NextResponse.json({ error: 'Choose a file first.' }, { status: 400 })
  const tooBig = faxSizeProblem(size)
  if (tooBig) return NextResponse.json({ error: tooBig }, { status: 400 })
  const path = faxStagingPathFor(randomUUID(), fileName)
  const { data, error } = await supabaseAdmin.storage.from(FAX_STAGING_BUCKET).createSignedUploadUrl(path)
  if (error || !data) return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
