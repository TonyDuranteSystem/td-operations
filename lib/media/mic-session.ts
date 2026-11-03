/**
 * One shared microphone for voice notes (Antonio, 3 Nov 2026: on the iPhone Home Screen app the phone asked "allow microphone?" again and again).
 * Asking the phone for the microphone on EVERY note, and letting it go after every note, makes iOS ask again. Here the first note asks, and the microphone is then kept
 * warm for a short while: between notes the tracks are switched off (silent), and after `IDLE_RELEASE_MS` of no recording, or when the app goes to the background,
 * the microphone is released for real (iOS ends it there anyway, and an open microphone makes other sounds on the phone quieter).
 * Browser only; the pure pieces are exported for tests.
 */

export const IDLE_RELEASE_MS = 3 * 60 * 1000

export interface MicTrackLike { readyState: string; enabled: boolean; stop(): void }
export interface MicStreamLike { getAudioTracks(): MicTrackLike[]; getTracks(): MicTrackLike[] }

/** True when the held stream can be used again: it has at least one audio track and every one is still live. */
export function isStreamReusable(stream: MicStreamLike | null | undefined): boolean {
  if (!stream) return false
  const tracks = stream.getAudioTracks()
  return tracks.length > 0 && tracks.every(t => t.readyState === 'live')
}

/** A short plain sentence for a failed microphone request. `blocked` = the person (or the phone's settings) said no. */
export function micErrorMessage(err: unknown): { blocked: boolean; message: string } {
  const name = err instanceof Error ? err.name : ''
  const text = err instanceof Error ? `${err.name} ${err.message}` : ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || /denied|permission/i.test(text)) {
    return {
      blocked: true,
      message: 'The microphone is blocked for this app. On iPhone: Settings → Safari → Microphone → set this site to Allow (or Ask), then close and reopen the app. On a computer: click the lock icon next to the address, then allow the microphone.',
    }
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { blocked: false, message: 'No microphone was found. Check that a microphone is connected and not used by another app.' }
  if (name === 'NotReadableError' || name === 'AbortError') return { blocked: false, message: 'The microphone is busy (another app or call is using it). Close it and try again.' }
  return { blocked: false, message: 'Could not start recording. Check your microphone connection and browser permissions.' }
}

let held: MediaStream | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let hideListener = false

function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }

/** Release the microphone for real (all tracks stopped). */
export function releaseMicNow(): void {
  clearIdle()
  const s = held
  held = null
  try { s?.getTracks().forEach(t => t.stop()) } catch { /* already gone */ }
}

/** Between notes: tracks go silent now, and the microphone is released for real after the idle time. */
export function releaseMicSoon(delayMs: number = IDLE_RELEASE_MS): void {
  const s = held
  if (!s) return
  try { s.getAudioTracks().forEach(t => { t.enabled = false }) } catch { /* ignore */ }
  clearIdle()
  idleTimer = setTimeout(releaseMicNow, delayMs)
}

/** The microphone for one recording: the warm one when it is still good (no new question to the person), else a fresh request. Throws what getUserMedia throws. */
export async function acquireMic(): Promise<MediaStream> {
  clearIdle()
  if (held && isStreamReusable(held)) {
    held.getAudioTracks().forEach(t => { t.enabled = true })
    return held
  }
  releaseMicNow()
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  held = stream
  if (!hideListener && typeof document !== 'undefined') {
    hideListener = true
    // The app went to the background: iOS ends the microphone there anyway; let it go cleanly so the next note asks for a fresh one.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && held && !recordingInProgress) releaseMicNow() })
  }
  return stream
}

/** The recorder tells us whether a note is being recorded, so the background rule never cuts a recording's own stream. */
let recordingInProgress = false
export function setRecordingInProgress(on: boolean): void { recordingInProgress = on }

/** Test hook. */
export function resetMicSessionForTests(): void { releaseMicNow(); recordingInProgress = false; hideListener = false }

/* ---- Screen Wake Lock: keep the screen on while a note is recorded (a dark screen stops the recording on iPhone) ---- */

interface WakeLockSentinelLike { release(): Promise<void> }
let wake: WakeLockSentinelLike | null = null
let wakeWanted = false
let wakeListener = false

async function requestWake(): Promise<void> {
  try {
    const nav = navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }
    if (!nav.wakeLock) return
    wake = await nav.wakeLock.request('screen')
  } catch { wake = null /* refused (battery saver, or not supported in this app): the recording still works */ }
}

/** Ask the phone to keep the screen on. Safe to call when unsupported. */
export function holdScreenAwake(): void {
  wakeWanted = true
  if (!wakeListener && typeof document !== 'undefined') {
    wakeListener = true
    // The phone drops the lock whenever the page is hidden; take it again when the person comes back to a note still being recorded.
    document.addEventListener('visibilitychange', () => { if (wakeWanted && document.visibilityState === 'visible') void requestWake() })
  }
  void requestWake()
}

export function releaseScreen(): void {
  wakeWanted = false
  const w = wake
  wake = null
  void w?.release().catch(() => {})
}
