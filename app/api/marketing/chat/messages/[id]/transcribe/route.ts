import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit } from "@/lib/portal/rate-limit"
import { transcribeVoice } from "@/lib/marketing/voice-transcribe"
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
  const r = await transcribeVoice({ apiKey, name: v.att.name, download: () => downloadFile(v.att.path) })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  await saveTranscript(id, body.index as number, v.att.path, r.transcript)
  return NextResponse.json({ transcript: r.transcript }, { headers: NO_STORE })
}
