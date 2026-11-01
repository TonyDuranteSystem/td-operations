/**
 * Recorded voice clips for every spoken alert (Antonio, 31 Oct 2026: "option one for every place a voice sound is set up").
 * TD Talk and TD Marketing used the browser's own speaking voice, which Chrome only allows after a click on the page (so a "click anywhere" bar showed after every reload).
 * A recorded clip is a sound file: Chrome can allow it for good (lock icon, Site settings, Sound, Allow). The words are the SAME phrases as before; a phrase with no clip (a new
 * person, a sender nobody recorded) still falls back to the browser voice. The WhatsApp clip lives in lib/whatsapp-sound.ts and is separate.
 * Pure helpers + three small browser helpers (play a clip, queue clips, ask whether the browser would let a sound start without a click).
 */
import { CLIENT_MESSAGE_PHRASE, TALK_FEATURE_PHRASE } from "@/lib/talk/voice-alert"

export const VOICE_CLIP_BASE = "/sounds/voice/"

/** People with a recorded "New <name> message in TD Talk" (first name, lower case). Add a name here AND record its clip in public/sounds/voice. */
export const TALK_CLIP_NAMES: readonly string[] = ["antonio", "luca", "rocco", "cristina", "jodi", "claude"]
/** People with a recorded "Message from <name>" (the TD Marketing team). */
export const MARKETING_CLIP_NAMES: readonly string[] = ["antonio", "rocco", "cristina"]

/** "Luca Degasper" / "antonio.durante" / " LUCA " -> "luca". The first word, lower case, cut at a space or a dot. */
export function clipNameKey(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().split(/[\s.]+/)[0] ?? ""
}

/** The clip for a spoken phrase, or null when nobody recorded it (the caller then uses the browser voice). */
export function clipUrlFor(phrase: string): string | null {
  const p = phrase.trim()
  const file = (f: string) => `${VOICE_CLIP_BASE}${f}.mp3`
  if (p === "Sound on") return file("sound-on")
  if (p === TALK_FEATURE_PHRASE) return file("talk-feature")
  if (p === CLIENT_MESSAGE_PHRASE) return file("client-message")
  const talk = /^New (.+) message in TD Talk$/.exec(p)
  if (talk) {
    const key = clipNameKey(talk[1])
    if (key === "team") return file("talk-team")
    return TALK_CLIP_NAMES.includes(key) ? file(`talk-${key}`) : null
  }
  const from = /^Message from (.+)$/.exec(p)
  if (from) {
    const key = clipNameKey(from[1])
    if (key === "someone") return file("from-someone")
    return MARKETING_CLIP_NAMES.includes(key) ? file(`from-${key}`) : null
  }
  return null
}

/** Plays one clip. `onFail` runs when the browser refuses (no click yet and Sound not allowed for the site) or the file is missing. Never throws; resolves when the clip ended or failed. */
export function playClip(url: string, onFail: () => void): Promise<void> {
  return new Promise<void>(resolve => {
    let done = false
    const finish = (failed: boolean) => { if (done) return; done = true; if (failed) { try { onFail() } catch { /* the fallback must never break the page */ } } resolve() }
    try {
      const clip = new Audio(url)
      clip.addEventListener("ended", () => finish(false))
      clip.addEventListener("error", () => finish(true))
      const started = clip.play()
      if (started && typeof started.catch === "function") started.catch(() => finish(true))
    } catch { finish(true) }
  })
}

let queue: Promise<void> = Promise.resolve()
/** Plays clips one after the other (several phrases in one look are not said on top of each other). */
export function playClipQueued(url: string, onFail: () => void): void {
  queue = queue.then(() => playClip(url, onFail))
}

/** A 50 ms silent sound, used only to ask the browser "would you let a sound start without a click?". */
const SILENT_CLIP =
  "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMAAAAAAAAAAAAAAA/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAAAwAAAbAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV////////////////////////////////////////////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQC8AAAAAAAAAGw9wpEpwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV"

let probe: Promise<boolean> | null = null
/** True when this browser already lets the page start a sound without a click (Chrome: Site settings, Sound, Allow). Asked once; a browser that cannot say counts as "no". */
export function soundAllowedWithoutClick(): Promise<boolean> {
  if (!probe) {
    probe = new Promise<boolean>(resolve => {
      try {
        const a = new Audio(SILENT_CLIP)
        const started = a.play()
        if (started && typeof started.then === "function") started.then(() => resolve(true), () => resolve(false))
        else resolve(false)
      } catch { resolve(false) }
    })
  }
  return probe
}

/** Test hook: forget the remembered answer. */
export function resetSoundProbe(): void { probe = null; queue = Promise.resolve() }
