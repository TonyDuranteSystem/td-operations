/**
 * TD Marketing — the spoken alert for a new message (pure; dev job 9aec66fa; Antonio, 29 Oct 2026: "I want notification with sound for new messages. The sound must say Message from Rocco").
 * The computer reads out "Message from <first name of the sender>" while a TD page is open in the browser and the person has switched Sound on (the browser only lets a page speak after a click, and
 * a closed browser cannot speak at all: the push notification covers that). The words are always English, as he asked. No database, no browser here: the screen part is `message-voice.tsx`.
 */

/** Where the person's choice and the shared bookkeeping live (this browser only; every tab of this browser reads the same). */
export const VOICE_KEYS = { on: "tdm_voice", since: "tdm_voice_since", spoken: "tdm_voice_spoken" } as const

/** How often an open page asks whether something new arrived, in milliseconds. */
export const VOICE_POLL_MS = 15_000
/** A page that was asleep (a closed laptop) is told about what came in during this long at most, so waking it up never reads out a day of messages. */
export const VOICE_MAX_AGE_MS = 10 * 60_000
/** The first look of a page (Sound just switched on) starts this far BEFORE now, so a message that came in while the request was still on its way is not lost; an unread message from the last few seconds is read out. */
export const VOICE_BASELINE_BACK_MS = 5_000
/** The most messages one answer carries, and the most phrases read out for one answer. */
export const VOICE_MAX_ITEMS = 20
export const VOICE_MAX_PHRASES = 3
/** How many message ids a browser remembers having read out (so a second tab never says the same one again). */
export const VOICE_SPOKEN_KEEP = 200

export interface VoiceAlertItem { id: string; kind: "lead" | "team"; sender: string; at: string }

/** "Antonio Durante" -> "Antonio"; an empty name stays empty (the phrase then has no name to say). */
export function firstNameOf(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? ""
}

/**
 * What to say for the messages that came in since the last look: one phrase per person, in the order they wrote ("Message from Rocco", "Message from Cristina"), never one per message, and at most
 * VOICE_MAX_PHRASES of them. A message whose sender has no name is said as "Message from someone".
 */
export function voicePhrases(items: ReadonlyArray<{ sender: string }>, max = VOICE_MAX_PHRASES): string[] {
  const seen: string[] = []
  for (const i of items) { const n = firstNameOf(i.sender) || "someone"; if (!seen.includes(n)) seen.push(n) }
  return seen.slice(0, max).map(n => `Message from ${n}`)
}

/** The point in time an answer starts from: the one the page sent when it is a real time and not older than VOICE_MAX_AGE_MS, else the oldest allowed. null = no usable time (the page only wants the clock). */
export function sinceFrom(raw: string | null | undefined, now: Date): string | null {
  if (!raw) return null
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return null
  const oldest = now.getTime() - VOICE_MAX_AGE_MS
  return new Date(Math.min(Math.max(t, oldest), now.getTime())).toISOString()
}

/** The time the first look hands back: the clock a little earlier (see VOICE_BASELINE_BACK_MS). */
export function baselineFrom(now: Date): string {
  return new Date(now.getTime() - VOICE_BASELINE_BACK_MS).toISOString()
}

/** The ids a browser remembers as read out, newest last, with the new ones added and the oldest dropped. */
export function rememberSpoken(known: readonly string[], add: readonly string[], keep = VOICE_SPOKEN_KEEP): string[] {
  const out = [...known]
  for (const id of add) if (!out.includes(id)) out.push(id)
  return out.slice(-keep)
}

/** The messages in an answer this browser has not read out yet. */
export function notSpokenYet<T extends { id: string }>(items: readonly T[], known: readonly string[]): T[] {
  const k = new Set(known)
  return items.filter(i => !k.has(i.id))
}

/** Reads the stored list of read-out ids; anything that is not a list of strings is an empty list (never an error on a screen). */
export function parseSpoken(raw: string | null | undefined): string[] {
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [] } catch { return [] }
}
