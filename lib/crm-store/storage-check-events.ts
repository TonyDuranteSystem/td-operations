/**
 * Client-side only: tells the company page's Storage check that something was just saved (an owner, a member, a role, the
 * name …) so it looks again and — when it finds something — opens the pop-up by itself. A page that reloads right after
 * the save keeps the wish in sessionStorage. Never throws.
 */
export const STORAGE_CHECK_EVENT = "storage-check-changed"
export const STORAGE_CHECK_FLAG = "storage-check-pending"

export function notifyStorageCheck(): void {
  try {
    if (typeof window === "undefined") return
    try { window.sessionStorage.setItem(STORAGE_CHECK_FLAG, "1") } catch { /* private window: the live event still works */ }
    window.dispatchEvent(new Event(STORAGE_CHECK_EVENT))
  } catch { /* never block a save */ }
}

/** true once, when a save asked for a look (clears the wish) */
export function takeStorageCheckWish(): boolean {
  try {
    if (typeof window === "undefined") return false
    const on = window.sessionStorage.getItem(STORAGE_CHECK_FLAG) === "1"
    if (on) window.sessionStorage.removeItem(STORAGE_CHECK_FLAG)
    return on
  } catch { return false }
}
