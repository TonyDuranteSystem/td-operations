/**
 * Voice notes on the self-hosted WhatsApp link — pure helpers (no I/O, unit-tested).
 *
 * The rules live in the database (wabridge_media_claim / wabridge_media_finish); this file parses the Mac's signed events, builds the
 * server-owned storage path, and words the screen states. Antonio 2026-09-26: keep the audio 180 days, transcript forever, only staff listen.
 */

import { HEARTBEAT_MAX_SKEW_MS } from "./wabridge-health"
import { MIME_EXTENSION } from "./wabridge-attachment"

export const VOICE_BUCKET = "wa-voice"
/** WhatsApp stops serving a voice note after roughly this long (measured 2026-09-26: 19 days ok, 26 days gone).
 *  Applied to every inbound media kind (voice/image/video/document) — measured for voice specifically, assumed
 *  (not independently measured) to hold for the others too, since it reflects WhatsApp's own media-serving
 *  window rather than anything voice-specific. Worst case if wrong: one wasted claim cycle, never a stuck row. */
export const MEDIA_MAX_AGE_DAYS = 25
export const RETENTION_DAYS = 180
/** Playback/view link lifetime — minted per play/view, never stored. */
export const PLAYBACK_URL_SECONDS = 300
export const MAX_AUDIO_BYTES = 26_214_400
/** Ceiling for a downloaded inbound image/video/document — matches the bucket's real limit and the same
 *  ceiling outbound attachments already use. */
export const MAX_MEDIA_BYTES = 67_108_864
export const MAX_TRANSCRIPT_CHARS = 50_000

/** Every value message_media.status may hold (validated in the database functions — deliberately no CHECK). */
export const MEDIA_STATUSES = ["waiting", "processing", "ready", "expired", "failed"] as const
export type MediaStatus = (typeof MEDIA_STATUSES)[number]

export const MEDIA_KINDS = ["voice", "image", "video", "document"] as const
export type MessageMediaKind = (typeof MEDIA_KINDS)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The ONLY place a voice note's audio path is built — the Mac never chooses one. Unchanged shape/location. */
export function voicePath(channelId: string, messageId: string): string {
  return `voice/${channelId}/${messageId}.m4a`
}

/** The ONLY place a non-voice inbound attachment's path is built — mirrors wabridge_media_finish's own
 *  recomputation exactly (same MIME_EXTENSION table as outbound attachments), so the two can never disagree. */
export function inboundMediaPath(channelId: string, messageId: string, mime: string | null | undefined): string {
  const ext = MIME_EXTENSION[(mime ?? "").toLowerCase().trim()] ?? "bin"
  return `media/${channelId}/${messageId}.${ext}`
}

function freshTs(ts: unknown, now: Date): boolean {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(now.getTime() - ts) <= HEARTBEAT_MAX_SKEW_MS
}

export type MediaClaimParse = null | { ok: false; reason: string } | { ok: true }

/** {event:"bridge.media.claim", ts}: the Mac asks for its next voice note to fetch. */
export function parseMediaClaim(body: unknown, now: Date): MediaClaimParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.media.claim") return null
  if (!freshTs(b.ts, now)) return { ok: false, reason: "stale or missing timestamp" }
  return { ok: true }
}

/** {event:"bridge.media.upload_url", ts, message_id, mime}: sent ONLY for a non-voice claim (voice already got
 *  its upload URL at claim time, since its path never depends on a discovered mime). The Mac calls this once
 *  it has actually downloaded the file and knows its real mime type. */
export type MediaUploadUrlParse = null | { ok: false; reason: string } | { ok: true; messageId: string; mime: string }

export function parseMediaUploadUrlRequest(body: unknown, now: Date): MediaUploadUrlParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.media.upload_url") return null
  if (!freshTs(b.ts, now)) return { ok: false, reason: "stale or missing timestamp" }
  if (typeof b.message_id !== "string" || !UUID_RE.test(b.message_id)) return { ok: false, reason: "bad message id" }
  if (typeof b.mime !== "string" || !b.mime.trim() || b.mime.length > 100) return { ok: false, reason: "bad mime" }
  return { ok: true, messageId: b.message_id, mime: b.mime.trim() }
}

export type MediaOutcome = "ready" | "expired" | "failed"

export type MediaResultParse =
  | null
  | { ok: false; reason: string }
  | {
      ok: true
      messageId: string
      outcome: MediaOutcome
      mime: string | null
      sizeBytes: number | null
      durationSeconds: number | null
      transcript: string | null
      language: string | null
      model: string | null
      error: string | null
    }

/** Remove NULs and control characters (keeps newlines/tabs) and cap the length. Never trims meaning; never logs. */
export function sanitizeTranscript(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()
  if (!cleaned) return null
  return cleaned.slice(0, MAX_TRANSCRIPT_CHARS)
}

/**
 * {event:"bridge.media.result", ts, message_id, outcome, mime?, size_bytes?, duration_seconds?, transcript?, language?, model?, error?}
 * `ready` REQUIRES a real size (the file itself is verified in storage by the route before the database is touched).
 * `maxBytes` is the caller's kind-aware ceiling (voice: MAX_AUDIO_BYTES; image/video/document: MAX_MEDIA_BYTES) —
 * the route looks up the real kind from message_media before calling this, since a pure parser has no DB access.
 */
export function parseMediaResult(body: unknown, now: Date, maxBytes: number = MAX_AUDIO_BYTES): MediaResultParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.media.result") return null
  if (!freshTs(b.ts, now)) return { ok: false, reason: "stale or missing timestamp" }
  if (typeof b.message_id !== "string" || !UUID_RE.test(b.message_id)) return { ok: false, reason: "bad message id" }
  if (b.outcome !== "ready" && b.outcome !== "expired" && b.outcome !== "failed") return { ok: false, reason: "bad outcome" }
  const err = typeof b.error === "string" ? b.error.slice(0, 300) : null
  const short = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)
  if (b.outcome !== "ready") {
    return { ok: true, messageId: b.message_id, outcome: b.outcome, mime: null, sizeBytes: null, durationSeconds: null, transcript: null, language: null, model: null, error: err }
  }
  const size = b.size_bytes
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > maxBytes) return { ok: false, reason: "bad size" }
  const mime = short(b.mime, 100)
  const dur = b.duration_seconds
  const duration = typeof dur === "number" && Number.isFinite(dur) && dur >= 0 && dur < 86_400 ? Math.round(dur) : null
  return {
    ok: true,
    messageId: b.message_id,
    outcome: "ready",
    mime,
    sizeBytes: size,
    durationSeconds: duration,
    transcript: sanitizeTranscript(b.transcript),
    language: short(b.language, 12),
    model: short(b.model, 80),
    error: null,
  }
}

export interface VoiceMediaView {
  status: MediaStatus | "none"
  transcript: string | null
  durationSeconds: number | null
  audioDeleted: boolean
}

export interface VoiceStateWording {
  /** true when a player should be offered */
  playable: boolean
  note: string | null
  tone: "neutral" | "warn"
}

/** What the chat says about a voice note's audio. Order matters: a deleted file is never "ready". */
export function describeVoiceState(m: VoiceMediaView): VoiceStateWording {
  if (m.audioDeleted) return { playable: false, note: "Audio deleted after 180 days — transcript kept", tone: "neutral" }
  switch (m.status) {
    case "ready":
      return { playable: true, note: null, tone: "neutral" }
    case "expired":
      return { playable: false, note: "Audio no longer available from WhatsApp", tone: "warn" }
    case "failed":
      return { playable: false, note: "Could not prepare this audio", tone: "warn" }
    case "waiting":
    case "processing":
    case "none":
    default:
      return { playable: false, note: "Preparing audio and transcript…", tone: "neutral" }
  }
}

/** True while a voice note can still change on its own (drives the faster refresh of the chat). */
export function isMediaPending(status: string, audioDeleted: boolean): boolean {
  return !audioDeleted && (status === "waiting" || status === "processing" || status === "none")
}
