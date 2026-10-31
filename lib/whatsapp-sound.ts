/**
 * The WhatsApp notification sound — browser side (dev job c84dfb4d). Pure helpers + localStorage; the tones themselves live in
 * lib/hooks/use-notification-sound.ts (SOUND_LIBRARY, synthesized in the browser — no audio files).
 *
 * Each person picks their own sound (or Off) per browser. Default: the recorded voice "New WhatsApp message" (Antonio, 31 Oct 2026) — a
 * short sound file, played like any tone, NOT the browser's speech engine (that one needs a click on the page after every reload; a
 * sound file can be allowed for good in Chrome: lock icon, Site settings, Sound, Allow). If the browser still refuses to play it,
 * the 'pop' tone sounds instead, so a message is never silent. Tones stay available as a choice; 'pop' is deliberately NOT the 'chime'
 * that portal chat, team chat and business events use.
 */

import { SOUND_LIBRARY, SOUND_NONE } from "@/lib/hooks/use-notification-sound"

export const WA_SOUND_PREF_KEY = "td-wa-sound"
/** The choice that plays the recorded voice instead of a tone. */
export const WA_SOUND_VOICE = "voice"
export const WA_SOUND_DEFAULT = WA_SOUND_VOICE
/** The tone that sounds when the browser refuses to play the voice file. */
export const WA_SOUND_FALLBACK_TONE = "pop"
export const WA_VOICE_CLIP_URL = "/sounds/new-whatsapp-message.mp3"

/** Last 'whatsapp' event this BROWSER already played a sound for — shared by all tabs of the browser (localStorage). */
export const WA_SOUND_LAST_EVENT_KEY = "td-wa-sound-last-event"

/** At least this long between two sounds in one tab (a burst of messages rings once, not ten times). */
export const WA_SOUND_MIN_GAP_MS = 1500

/** Minimal storage shape (window.localStorage or a test double). */
export interface SoundStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const VALID_IDS = new Set<string>([SOUND_NONE, WA_SOUND_VOICE, ...SOUND_LIBRARY.map((s) => s.id)])

/** A stored value → a usable tone id. Unknown / missing / hand-edited values fall back to the default. */
export function normalizeSoundPref(raw: string | null | undefined): string {
  return raw && VALID_IDS.has(raw) ? raw : WA_SOUND_DEFAULT
}

export function readSoundPref(storage: SoundStorage | null): string {
  try {
    return normalizeSoundPref(storage?.getItem(WA_SOUND_PREF_KEY))
  } catch {
    return WA_SOUND_DEFAULT // private window / blocked site data
  }
}

export function writeSoundPref(storage: SoundStorage | null, id: string): void {
  try {
    storage?.setItem(WA_SOUND_PREF_KEY, normalizeSoundPref(id))
  } catch {
    /* a preference that cannot be saved is not an error */
  }
}

/** How many new customer messages a 'whatsapp' signal carries: its payload `{ inbound: n }`; anything else = 0 (no sound). */
export function inboundCountFromPayload(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0
  const n = (payload as { inbound?: unknown }).inbound
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : 0
}

/**
 * Several tabs of one browser all receive the same signal; only the first to claim it plays. Returns true if THIS caller should play.
 * (Two tabs claiming in the same millisecond can both win — the caller adds a few ms of random delay first, which makes that very rare;
 * the cost of the rare double is two beeps, never a missed one.)
 */
export function claimSoundEvent(storage: SoundStorage | null, eventId: string): boolean {
  if (!eventId) return true
  try {
    if (storage?.getItem(WA_SOUND_LAST_EVENT_KEY) === eventId) return false
    storage?.setItem(WA_SOUND_LAST_EVENT_KEY, eventId)
  } catch {
    /* no storage → can't de-dupe across tabs; playing is the safer failure */
  }
  return true
}

/** Enough time since this tab's last sound? */
export function gapElapsed(nowMs: number, lastPlayedMs: number): boolean {
  return nowMs - lastPlayedMs >= WA_SOUND_MIN_GAP_MS
}

/**
 * Plays the recorded voice. `onFail` runs when the browser refuses (no click on the page yet and Sound not allowed for the site, a missing
 * file, no audio): the caller plays the fallback tone then. Never throws.
 */
export function playVoiceClip(onFail: () => void): void {
  try {
    const clip = new Audio(WA_VOICE_CLIP_URL)
    const started = clip.play()
    if (started && typeof started.catch === "function") started.catch(() => onFail())
  } catch {
    onFail()
  }
}
