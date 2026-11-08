import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isStaffUser } from '@/lib/auth'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { checkRateLimit } from '@/lib/portal/rate-limit'
import { decideMessageVoiceAccess } from '@/lib/portal/chat-voice'
import { transcribeVoice } from '@/lib/marketing/voice-transcribe'
import { VOICE_MAX_BYTES, isTrustedAudioUrl, pickVoiceAttachment, withTranscript } from '@/lib/team/voice-text'
import { NextRequest, NextResponse } from 'next/server'

// two speech-service calls (the words, then the English version) of up to 45 s each, plus the download: 60 s was not enough for a long note in another language
export const maxDuration = 120

/**
 * POST /api/portal/chat/message/[id]/transcribe { index } — "Show text" under a voice note in the CLIENT PORTAL chat (dev job 753b2909), the same
 * button TD Talk and the marketing chat have: OpenAI Whisper in the language spoken, plus an English version when it is another language; saved ONCE
 * on the attachment so the client and the team both see it and nothing is sent to the speech service twice. Only when somebody taps the button.
 * Staff: any message. A client: only a message of a company they may use chat for, or their own contact thread (decideMessageVoiceAccess).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // TD staff only — isDashboardUser lets every non-client login in (a managed partner, a marketing login); those must not open a client's message
  const isStaff = isStaffUser(user)
  const isClient = (user.app_metadata as Record<string, unknown> | undefined)?.role === 'client'
  if (!isStaff && !isClient) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  if (!checkRateLimit(`portal-transcribe:${user.id}`, 20, 60_000).allowed) {
    return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 })
  }
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Voice-to-text is not configured here.' }, { status: 503 })

  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { index?: unknown }

  const { data: msg } = await supabaseAdmin
    .from('portal_messages')
    .select('id, account_id, contact_id, attachments, deleted_at')
    .eq('id', id)
    .maybeSingle()
  if (!msg || msg.deleted_at) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })

  // The message id comes from the browser: decide from the stored message, never from anything the browser says about it.
  const allowed = decideMessageVoiceAccess({
    isStaff,
    isClient,
    accountAllowed: !isStaff && msg.account_id ? await canAccessAccount(user, msg.account_id, 'chat') : false,
    authContactId: getClientContactId(user),
    message: { account_id: msg.account_id, contact_id: msg.contact_id },
  })
  if (!allowed) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const att = pickVoiceAttachment(msg.attachments, body.index)
  if (!att || !att.url) return NextResponse.json({ error: 'That is not a voice note.' }, { status: 400 })
  if (att.transcript) return NextResponse.json({ transcript: att.transcript, cached: true })
  if (!isTrustedAudioUrl(att.url, (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim())) {
    return NextResponse.json({ error: 'This audio cannot be transcribed.' }, { status: 400 })
  }

  const url = att.url
  // A very long note is refused from its size alone, before the whole file is pulled into memory.
  try {
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
    const size = Number(head.headers.get('content-length'))
    if (head.ok && Number.isFinite(size) && size > VOICE_MAX_BYTES) {
      return NextResponse.json({ error: 'This voice note is too long to transcribe (over 25 MB).' }, { status: 400 })
    }
  } catch { /* the size check is a shortcut only — the download below checks again */ }

  const result = await transcribeVoice({
    apiKey,
    name: att.name || 'voice-note.m4a',
    download: async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      return res.ok ? await res.blob() : null
    },
  })
  if (result.ok === false) return NextResponse.json({ error: result.error }, { status: result.status })

  // Read the message again right before saving: the speech call took a while, and the copy read at the top may be stale (another note on the same message could have been read meanwhile).
  const { data: fresh } = await supabaseAdmin.from('portal_messages').select('attachments').eq('id', id).maybeSingle()
  const next = withTranscript(fresh?.attachments, body.index as number, url, result.transcript)
  if (next) {
    const { error } = await supabaseAdmin.from('portal_messages').update({ attachments: next as never }).eq('id', id)
    if (error) console.error('[portal transcribe] could not save the text:', error.message)
  }
  return NextResponse.json({ transcript: result.transcript })
}
