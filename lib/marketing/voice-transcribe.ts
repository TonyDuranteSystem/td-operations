/**
 * TD Marketing — "Show text" under a voice note (server; shared by the lead chat and the team chat). OpenAI Whisper in the language spoken, plus an English version when it is another
 * language. The audio is read from our private bucket by its stored path (never from an address the browser sends). Returns the transcript or a plain reason; saving it is the caller's job.
 */
import { VOICE_MAX_BYTES, needsEnglish, type VoiceTranscript } from "@/lib/team/voice-text"

export type TranscribeResult = { ok: true; transcript: VoiceTranscript } | { ok: false; error: string; status: number }

export async function transcribeVoice(i: { apiKey: string; name: string; download: () => Promise<Blob | null> }): Promise<TranscribeResult> {
  try {
    const blob = await i.download()
    if (!blob) return { ok: false, error: "Could not load the audio.", status: 502 }
    if (blob.size > VOICE_MAX_BYTES) return { ok: false, error: "This voice note is too long to transcribe (over 25 MB).", status: 400 }
    if (blob.size === 0) return { ok: false, error: "This voice note is empty.", status: 400 }
    const whisper = async (path: "transcriptions" | "translations", format: "verbose_json" | "json") => {
      const form = new FormData()
      form.append("file", blob, i.name || "voice-note.m4a")
      form.append("model", "whisper-1")
      form.append("response_format", format)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 45_000)
      try {
        const r = await fetch(`https://api.openai.com/v1/audio/${path}`, { method: "POST", headers: { Authorization: `Bearer ${i.apiKey}` }, body: form, signal: ctrl.signal })
        if (!r.ok) throw new Error(`speech service ${r.status}`)
        return (await r.json()) as { text?: string; language?: string }
      } finally { clearTimeout(timer) }
    }
    const said = await whisper("transcriptions", "verbose_json")
    const text = (said.text ?? "").trim()
    if (!text) return { ok: false, error: "No speech was found in this voice note.", status: 422 }
    const language = (said.language ?? "").trim().toLowerCase()
    let english: string | null = null
    if (needsEnglish(language)) english = ((await whisper("translations", "json")).text ?? "").trim() || null
    return { ok: true, transcript: { text, language, english, at: new Date().toISOString() } }
  } catch (err) {
    console.error("[marketing transcribe]", err instanceof Error ? err.message : err)
    return { ok: false, error: "Could not turn this voice note into text. Please try again.", status: 502 }
  }
}
