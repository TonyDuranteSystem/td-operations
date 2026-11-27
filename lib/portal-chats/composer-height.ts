// How tall the Portal Chats message box may grow (dev job cb02b03d).
//
// On the website the box grows with the text up to 300 px. On the iPad / iPhone app with the keyboard open the visible screen is
// only about 340 px tall, so a 300 px box ran under the keyboard and the lines being typed were out of sight. In the app the cap
// is a share of the VISIBLE height (so the box always scrolls inside itself and the typed line stays on screen); the website is
// untouched. Pure functions, no DOM, so they are unit-tested.

export const COMPOSER_MAX_PX = 300
export const COMPOSER_MIN_PX = 44
/** the app's cap, as a share of the visible height ("about a third of the screen") */
export const COMPOSER_APP_SHARE = 0.3
/** never smaller than about two lines, even on a very short screen (phone held sideways with the keyboard open) */
export const COMPOSER_APP_FLOOR_PX = 68

/** The tallest the box may be right now. `visibleHeight` is the height of what the person can actually see (null = not measured yet). */
export function composerMaxHeight(visibleHeight: number | null, appMode: boolean): number {
  if (!appMode) return COMPOSER_MAX_PX
  if (visibleHeight === null || !Number.isFinite(visibleHeight) || visibleHeight <= 0) return COMPOSER_MAX_PX
  const share = Math.round(visibleHeight * COMPOSER_APP_SHARE)
  return Math.min(COMPOSER_MAX_PX, Math.max(COMPOSER_APP_FLOOR_PX, share))
}

/** The height to give the box: as tall as its text needs, but not under the minimum and not over the cap. */
export function composerHeight(scrollHeight: number, cap: number): number {
  return Math.max(COMPOSER_MIN_PX, Math.min(scrollHeight, cap))
}

/** Rounds a measured height to the nearest 10 px so the page does not redraw on every pixel while the keyboard slides up. */
export function bucketVisibleHeight(height: number): number {
  return Math.max(10, Math.round(height / 10) * 10)
}

/** A usable, rounded reading of the visible height, or null when the reading says nothing (0, negative, not a number: page hidden or not laid out yet). */
export function usableVisibleHeight(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  return bucketVisibleHeight(raw)
}
