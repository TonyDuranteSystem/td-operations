import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { reportSystemError } from '@/lib/system-errors'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'

/**
 * POST /api/team/upload-url
 * Signed direct-to-Storage upload URL for team chat attachments (100MB), so the
 * browser bypasses the serverless request-body limit (the flaw the old streaming
 * internal upload had). Staff-only. Body: { thread_id, file_name }.
 * Lands in the PUBLIC `assets` bucket under team-chat/<threadId>/ — the send
 * route validates every attachment URL starts with our Storage host.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const threadId: string | null = body.thread_id || null
  const fileName: string | null = typeof body.file_name === 'string' ? body.file_name : null
  if (!threadId) return NextResponse.json({ error: 'thread_id required' }, { status: 400 })
  if (!fileName) return NextResponse.json({ error: 'file_name required' }, { status: 400 })

  // Thread must exist (cheap guard against writing orphan objects).
  const { data: thread } = await supabaseAdmin
    .from('internal_threads')
    .select('id')
    .eq('id', threadId)
    .single()
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  const storagePath = `team-chat/${threadId}/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage
    .from('assets')
    .createSignedUploadUrl(storagePath)
  if (error || !data) {
    console.error('Team chat signed-URL error:', error)
    // Previously console.error only — invisible on /system-health. This is
    // the server-side half of a failed team-chat attachment upload; the
    // client-side half (a network-level failure on the PUT itself) reports
    // via POST /api/system-errors/report from lib/team/attachment.ts.
    await reportSystemError({
      source: 'server',
      route: 'team/upload-url',
      method: 'POST',
      http_status: 500,
      message: error?.message || 'createSignedUploadUrl returned no data',
      context: { thread_id: threadId },
    })
    return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  }

  const { data: urlData } = supabaseAdmin.storage.from('assets').getPublicUrl(storagePath)
  return NextResponse.json({
    signedUrl: data.signedUrl,
    token: data.token,
    path: storagePath,
    publicUrl: urlData.publicUrl,
  })
}
