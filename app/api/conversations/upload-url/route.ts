import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveCommParticipant, participantCanAccess } from '@/lib/td-communication/queries'
import { logPartnerAccess } from '@/lib/td-communication/partner-access-log'
import { randomUUID } from 'crypto'

export const dynamic = 'force-dynamic'

/**
 * POST /api/conversations/upload-url — short-lived signed upload URL so the
 * browser uploads attachments DIRECTLY to Storage (bypassing the serverless
 * body limit), same pattern as the portal chat. Caller must be a participant of
 * the conversation. Lands in the PUBLIC `assets` bucket under
 * comm-attachments/<conversation_id>/.
 *
 * Body: { conversation_id, file_name } → { signedUrl, token, path, publicUrl }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const participant = await resolveCommParticipant(user)
  if (!participant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null
  const fileName = typeof body.file_name === 'string' ? body.file_name : null
  if (!conversationId) return NextResponse.json({ error: 'conversation_id required' }, { status: 400 })
  if (!fileName) return NextResponse.json({ error: 'file_name required' }, { status: 400 })

  if (!(await participantCanAccess(conversationId, participant))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  const storagePath = `comm-attachments/${conversationId}/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage.from('assets').createSignedUploadUrl(storagePath)
  if (error || !data) {
    console.error('Comm chat signed-URL error:', error)
    return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  }
  const { data: urlData } = supabaseAdmin.storage.from('assets').getPublicUrl(storagePath)

  if (participant.type === 'partner') {
    logPartnerAccess({
      partnerId: participant.id,
      surface: 'chat_upload',
      method: 'POST',
      path: '/api/conversations/upload-url',
      resource: storagePath,
      detail: { conversation_id: conversationId, file_name: fileName.slice(0, 120) },
      req,
    })
  }

  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path: storagePath, publicUrl: urlData.publicUrl })
}
