/**
 * How much to shrink an email so it fits the phone's width (TD Social app, dev job 2072bc3e, Step 1b).
 * 1 = leave it alone (it already fits, or the numbers make no sense). Never grows an email, never goes below a readable
 * floor: an email about 3x wider than the phone is shown at 0.33 at the very smallest (below that the text is unreadable
 * anyway); anything even wider is cut off at the right edge rather than shrunk to dust.
 */
export const MIN_FIT_SCALE = 0.33

export function fitScale(naturalWidth: number, availableWidth: number): number {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(availableWidth)) return 1
  if (naturalWidth <= 0 || availableWidth <= 0) return 1
  if (naturalWidth <= availableWidth + 2) return 1
  return Math.max(MIN_FIT_SCALE, availableWidth / naturalWidth)
}
