/**
 * Voice-note text for Team Chat / TD Talk (dev job c1e326dd). Pure rules — the route (app/api/team/messages/[id]/transcribe)
 * does the network work. A person taps "Show text" under a voice note; the words are written ONCE onto that attachment
 * (`transcript`) so both people see them and nothing is sent to the speech service twice.
 */

export interface VoiceTranscript {
  /** What was said, in the language it was said in. */
  text: string
  /** Language name as the speech service reports it, lower-case ("italian", "english"). */
  language: string
  /** English version; null when the note was already English. */
  english: string | null
  at: string
}

/** Whisper's own cap on a single upload. */
export const VOICE_MAX_BYTES = 25 * 1024 * 1024

type Att = { url?: string; name?: string; mime_type?: string; transcript?: VoiceTranscript | null } & Record<string, unknown>

/** The attachment at `index` — only if it exists and is audio. Null otherwise. */
export function pickVoiceAttachment(attachments: unknown, index: unknown): Att | null {
  if (!Array.isArray(attachments)) return null
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= attachments.length) return null
  const a = attachments[index] as Att | null
  if (!a || typeof a.url !== 'string') return null
  const mime = (a.mime_type || '').toLowerCase()
  const audio = mime ? mime.startsWith('audio/') : /\.(m4a|mp3|ogg|oga|opus|wav|webm|aac|mp4)(\?|$)/i.test(a.name || a.url)
  return audio ? a : null
}

/**
 * The browser supplies nothing but an index, but the stored URL came from an upload — never fetch a host we do not own.
 * Fails closed when the Supabase URL is not configured.
 */
export function isTrustedAudioUrl(url: string, supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return false
  return url.startsWith(`${supabaseUrl.replace(/\/+$/, '')}/`)
}

/** Whisper reports the language as a name; "english" needs no translation. */
export function needsEnglish(language: string): boolean {
  const l = language.trim().toLowerCase()
  return l !== '' && l !== 'english' && l !== 'en'
}

/** Copy of `attachments` with the transcript written onto the attachment at `index` (matched by url as well, so a concurrent edit cannot misplace it). */
export function withTranscript(attachments: unknown, index: number, url: string, transcript: VoiceTranscript): Att[] | null {
  if (!Array.isArray(attachments)) return null
  const a = attachments[index] as Att | undefined
  if (!a || a.url !== url) return null
  return attachments.map((x, i) => (i === index ? { ...(x as Att), transcript } : (x as Att)))
}

/** Plain-text block for the UI: English first when there is a translation. */
export function transcriptLines(t: VoiceTranscript): Array<{ label: string; text: string }> {
  const lines: Array<{ label: string; text: string }> = []
  if (t.english) lines.push({ label: 'English', text: t.english })
  const lang = t.language ? t.language.charAt(0).toUpperCase() + t.language.slice(1) : 'Original'
  lines.push({ label: t.english ? lang : 'Text', text: t.text })
  return lines
}
