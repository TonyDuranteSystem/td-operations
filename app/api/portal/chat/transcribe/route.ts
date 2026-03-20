import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/transcribe
 * Accepts audio file, returns transcribed text via OpenAI Whisper.
 *
 * Requires OPENAI_API_KEY env var.
 * Body: FormData with 'audio' file and optional 'language' (en, it, es, etc.)
 */
export async function POST(request: NextRequest) {
  // Rate limit: max 20 transcriptions per minute
  const rl = checkRateLimit(getRateLimitKey(request) + ':transcribe', 20, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please wait.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 10) } })
  }

  // Auth check
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Transcription service not configured' }, { status: 503 })
  }

  try {
    const formData = await request.formData()
    const audio = formData.get('audio') as File | null
    const language = (formData.get('language') as string) || 'en'

    if (!audio) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
    }

    // Max 25MB (Whisper limit)
    if (audio.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'Audio too large (max 25MB)' }, { status: 400 })
    }

    // Send to OpenAI Whisper API — no language param = auto-detect
    // Whisper supports 97 languages and auto-detects perfectly
    const whisperForm = new FormData()
    whisperForm.append('file', audio, audio.name || 'recording.webm')
    whisperForm.append('model', 'whisper-1')
    whisperForm.append('response_format', 'json')

    // 30s timeout for Whisper
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: whisperForm,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error('[transcribe] Whisper error:', err)
      return NextResponse.json({ error: 'Transcription failed' }, { status: 500 })
    }

    const result = await res.json()
    return NextResponse.json({ text: result.text || '' })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'Transcription timed out. Try a shorter recording.' }, { status: 504 })
    }
    console.error('[transcribe] Error:', err)
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 })
  }
}
