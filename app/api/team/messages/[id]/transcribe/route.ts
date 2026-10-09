import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { assertGroupAccess } from '@/lib/team/groups'
import { checkRateLimit } from '@/lib/portal/rate-limit'
import {
  VOICE_MAX_BYTES, isTrustedAudioUrl, needsEnglish, pickVoiceAttachment, withTranscript, type VoiceTranscript,
} from '@/lib/team/voice-text'
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60

/**
 * POST /api/team/messages/[id]/transcribe — "Show text" under a voice note in Team Chat / TD Talk.
 * Body: { index } (which attachment). Transcribes with OpenAI Whisper, adds an English version when the note is in another
 * language, and saves the result ON the attachment so it is computed once and both people see it. Only runs when a person
 * taps the button — nothing is transcribed automatically. Staff only; a group's or a DM's notes only for its members.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const rl = checkRateLimit(`team-transcribe:${user.id}`, 20, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Voice-to-text is not configured here.' }, { status: 503 })

  const { id: msgId } = await params
  const body = await request.json().catch(() => ({}))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: msg } = await db.from('internal_messages').select('id, thread_id, attachments, deleted_at').eq('id', msgId).maybeSingle()
  if (!msg || msg.deleted_at) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })

  // The message id comes from the browser: a group is for its members, a direct message for its two people.
  const { data: thread } = await db.from('internal_threads').select('thread_type, dm_key').eq('id', msg.thread_id).maybeSingle()
  if (!thread) return NextResponse.json({ error: 'Message not found.' }, { status: 404 })
  if (thread.thread_type === 'dm' && !String(thread.dm_key ?? '').split(':').includes(user.id)) {
    return NextResponse.json({ error: 'This is not your conversation.' }, { status: 403 })
  }
  const access = await assertGroupAccess(msg.thread_id, user.id)
  if (access.kind === 'denied') return NextResponse.json({ error: 'You are not in this group.' }, { status: 403 })

  const att = pickVoiceAttachment(msg.attachments, body.index)
  if (!att || !att.url) return NextResponse.json({ error: 'That is not a voice note.' }, { status: 400 })
  if (att.transcript) return NextResponse.json({ transcript: att.transcript, cached: true })
  if (!isTrustedAudioUrl(att.url, process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    return NextResponse.json({ error: 'This audio cannot be transcribed.' }, { status: 400 })
  }

  try {
    const audioRes = await fetch(att.url)
    if (!audioRes.ok) return NextResponse.json({ error: 'Could not load the audio.' }, { status: 502 })
    const blob = await audioRes.blob()
    if (blob.size > VOICE_MAX_BYTES) return NextResponse.json({ error: 'This voice note is too long to transcribe (over 25 MB).' }, { status: 400 })
    if (blob.size === 0) return NextResponse.json({ error: 'This voice note is empty.' }, { status: 400 })

    const whisper = async (path: 'transcriptions' | 'translations', format: 'verbose_json' | 'json') => {
      const form = new FormData()
      form.append('file', blob, att.name || 'voice-note.m4a')
      form.append('model', 'whisper-1')
      form.append('response_format', format)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 45_000)
      try {
        const r = await fetch(`https://api.openai.com/v1/audio/${path}`, {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`speech service ${r.status}`)
        return await r.json() as { text?: string; language?: string }
      } finally { clearTimeout(timer) }
    }

    const said = await whisper('transcriptions', 'verbose_json')
    const text = (said.text ?? '').trim()
    if (!text) return NextResponse.json({ error: 'No speech was found in this voice note.' }, { status: 422 })
    const language = (said.language ?? '').trim().toLowerCase()
    let english: string | null = null
    if (needsEnglish(language)) {
      const tr = await whisper('translations', 'json')
      english = (tr.text ?? '').trim() || null
    }

    const transcript: VoiceTranscript = { text, language, english, at: new Date().toISOString() }

    // Re-read right before writing so a message edited meanwhile is not overwritten with a stale copy.
    const { data: fresh } = await db.from('internal_messages').select('attachments').eq('id', msgId).maybeSingle()
    const merged = withTranscript(fresh?.attachments, body.index, att.url, transcript)
    if (merged) {
      await db.from('internal_messages').update({ attachments: merged }).eq('id', msgId)
    }
    return NextResponse.json({ transcript })
  } catch (err) {
    console.error('[team transcribe]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not turn this voice note into text. Please try again.' }, { status: 502 })
  }
}
