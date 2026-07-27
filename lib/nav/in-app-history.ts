/**
 * How deep the user has navigated INSIDE the app since this page load.
 *
 * The global Back arrow needs one question answered: "is there an in-app entry
 * to go back to, or would Back drop out of the app / dead-end?" On a fresh load
 * or a deep link the answer is no, and Back should go home instead.
 *
 * ⚠️ WHY A COUNTER AND NOT `window.history.state.idx`, AND NOT PATHNAME ALONE —
 * both were tried and both were wrong (2026-07-26/27, found by real browser QA):
 *   1. `history.state.idx` — the Next.js App Router does NOT populate it
 *      (state is {__NA, __PRIVATE_NEXTJS_INTERNALS_TREE}), so the guard was
 *      always false and EVERY Back went home.
 *   2. pathname-change only — switching chats inside Portal Chats changes just
 *      the QUERY STRING, so the flag never flipped and Back still went home
 *      (Antonio: "I click on one chat, then change chat, then hit the arrow —
 *      it goes to home dashboard"). Verified: Back pushed '/' and history.length
 *      went UP instead of going back.
 * So every real in-app move — a route change AND a selection recorded by
 * useSelectionHistory — reports itself here explicitly. No framework internals.
 *
 * Module-scoped on purpose: shared by the desktop header and the mobile app-bar
 * instances of the button, and it must survive their remounts.
 */
let depth = 0
let popBound = false

function bindPop() {
  if (popBound || typeof window === 'undefined') return
  popBound = true
  // Any Back/Forward pop consumes one level. Clamped at 0 so an unmatched pop
  // (e.g. a history entry we never counted) can't drive it negative and make
  // Back look unavailable when it is.
  window.addEventListener('popstate', () => { depth = Math.max(0, depth - 1) })
}

/** Record one in-app forward move (route change or an in-page selection push). */
export function markInAppNavigation(): void {
  bindPop()
  depth += 1
}

/** True when Back has somewhere in-app to return to. */
export function canGoBackInApp(): boolean {
  return depth > 0
}

/** Test seam — reset the counter between cases. */
export function __resetInAppHistoryDepth(): void {
  depth = 0
}
