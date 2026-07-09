/**
 * POST /api/tools/pnl/[id]/upload — add a statement to a workspace (STAFF ONLY).
 *
 * Thin: archives the file to workspace-scoped storage and enqueues one
 * `ingest_workspace_statement` job (the worker parses + categorizes into the
 * ISOLATED workspace table). Mirrors the portal uploader's async design so a
 * large PDF never overruns the request.
 */

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { saveAndEnqueueWorkspaceUpload } from '@/lib/tax/workspace-upload-enqueue'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  try {
    const form = await request.formData()
    const file = form.get('file')
    const bankLabel = String(form.get('bank_label') ?? form.get('bank_name') ?? 'Bank')
    const accountNumber = String(form.get('account_number') ?? '').trim() || null
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 })
    if (file.size === 0) return NextResponse.json({ error: 'This file is empty — please upload the statement as your bank exports it.' }, { status: 400 })
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 20 MB. Upload one statement at a time.` }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const r = await saveAndEnqueueWorkspaceUpload({ workspaceId: params.id, bankLabel, accountNumber, buffer, fileName: file.name })
    return NextResponse.json({ queued: r.queued, alreadyQueued: r.alreadyQueued, fileName: file.name })
  } catch (err) {
    console.error('[tools/pnl] upload failed:', err)
    return NextResponse.json({ error: err instanceof Error && err.message ? err.message : 'Upload failed — please try again.' }, { status: 500 })
  }
}
