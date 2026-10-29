/**
 * Is the microphone actually hearing anything? (pure; TD Marketing, dev job 9aec66fa — Antonio, 29 Oct 2026: two voice notes to Rocco came out silent and nothing told him.)
 * A muted or wrong input device sends exact silence; even a quiet voice is far above this line. Fail open: when the level cannot be measured the recording is sent as before.
 */
export const SOUND_THRESHOLD = 0.004
/** After this many seconds of recording with no sound at all, the screen warns the person while they can still fix it. */
export const SILENT_WARN_AFTER_SECONDS = 3

/** The loudness (root mean square, 0..1) of one slice of samples. */
export function rmsOf(samples: ArrayLike<number>): number {
  const n = samples.length
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) { const s = samples[i]; sum += s * s }
  return Math.sqrt(sum / n)
}

/** True when a slice (or the loudest slice of a whole recording) is loud enough to be sound. */
export function isSound(level: number): boolean {
  return Number.isFinite(level) && level >= SOUND_THRESHOLD
}

/** The bar's fill, 0..1: speech sits around 0.02-0.2, so the scale is stretched to show it. */
export function meterFill(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0
  return Math.min(1, Math.sqrt(level) * 2.2)
}
