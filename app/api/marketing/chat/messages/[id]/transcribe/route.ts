import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit } from "@/lib/portal/rate-limit"
import { VOICE_MAX_BYTES, needsEnglish, type VoiceTranscript } from "@/lib/team/voice-text"
import { NO_STORE, downloadFile, requireChatAccess, saveTranscript, voiceAttachment } from "@/lib/marketing/lead-chat-server"

export const maxDuration = 60

/**
 * POST /api/marketing/chat/messages/[id]/transcribe { index } — "Show text" under a voice note, the same as TD Talk's: OpenAI Whisper in the language spoken, plus an
 * English version when it is another language; saved once on the attachment so both people see it and nothing is sent twice. Only when somebody taps the button.
 * The audio is read from our private bucket by its stored path (never from an address the browser sends).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireChatAccess()
  if (g.res) return g.res
  if (!checkRateLimit(`mkt-transcribe:${g.ctx.user.id}`, 20, 60_000).allowed) return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429, headers: NO_STORE })
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: "Voice-to-text is not configured here." }, { status: 503, headers: NO_STORE })
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { index?: unknown }
  const v = await voiceAttachment(g.ctx, id, body.index)
  if (!v) return NextResponse.json({ error: "That is not a voice note." }, { status: 400, headers: NO_STORE })
  if (v.att.transcript) return NextResponse.json({ transcript: v.att.transcript, cached: true }, { headers: NO_STORE })
  try {
    const blob = await downloadFile(v.att.path)
    if (!blob) return NextResponse.json({ error: "Could not load the audio." }, { status: 502, headers: NO_STORE })
    if (blob.size > VOICE_MAX_BYTES) return NextResponse.json({ error: "This voice note is too long to transcribe (over 25 MB)." }, { status: 400, headers: NO_STORE })
    if (blob.size === 0) return NextResponse.json({ error: "This voice note is empty." }, { status: 400, headers: NO_STORE })
    const whisper = async (path: "transcriptions" | "translations", format: "verbose_json" | "json") => {
      const form = new FormData()
      form.append("file", blob, v.att.name || "voice-note.m4a")
      form.append("model", "whisper-1")
      form.append("response_format", format)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 45_000)
      try {
        const r = await fetch(`https://api.openai.com/v1/audio/${path}`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: ctrl.signal })
        if (!r.ok) throw new Error(`speech service ${r.status}`)
        return (await r.json()) as { text?: string; language?: string }
      } finally { clearTimeout(timer) }
    }
    const said = await whisper("transcriptions", "verbose_json")
    const text = (said.text ?? "").trim()
    if (!text) return NextResponse.json({ error: "No speech was found in this voice note." }, { status: 422, headers: NO_STORE })
    const language = (said.language ?? "").trim().toLowerCase()
    let english: string | null = null
    if (needsEnglish(language)) english = ((await whisper("translations", "json")).text ?? "").trim() || null
    const transcript: VoiceTranscript = { text, language, english, at: new Date().toISOString() }
    await saveTranscript(id, body.index as number, v.att.path, transcript)
    return NextResponse.json({ transcript }, { headers: NO_STORE })
  } catch (err) {
    console.error("[marketing transcribe]", err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "Could not turn this voice note into text. Please try again." }, { status: 502, headers: NO_STORE })
  }
}
