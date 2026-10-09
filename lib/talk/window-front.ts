/**
 * Is this window in front of the person? (dev job c1e326dd — the READ RULE for Team Chat / TD Talk.)
 *
 * `document.hasFocus()` is NOT usable for this: installed phone apps, the Mac app and some browsers answer "no" while the
 * person is looking straight at the chat — and a chat that is never marked read leaves the sender's tick single forever
 * (found 2026-10-09 right after the stricter rule shipped). So this FAILS OPEN: a window counts as in front unless the
 * browser actually told us it lost focus (`blur` — another window was clicked on), and any tap, click or keypress inside
 * the window counts as "you are here" again.
 */
let front = true
let installed = false

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('blur', () => { front = false })
  window.addEventListener('focus', () => { front = true })
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(ev, () => { front = true }, { passive: true, capture: true })
  }
}

/** True unless the window reported losing focus and has had no interaction since. */
export function isWindowInFront(): boolean {
  install()
  return front
}

/** The full rule: on screen (not a hidden tab / locked phone) AND the window is in front. */
export function isBeingViewed(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && isWindowInFront()
}
