/**
 * "Only one guided tour at a time" (dev job f3f3e237). The WhatsApp inbox tour and the floating-windows
 * tour can both want the screen on a person's first day; two at once would sit on top of each other.
 * A tour takes the lock when it starts and gives it back when it ends; anything that would START a tour by
 * itself (an auto-start, a "new feature" prompt) first checks that nobody holds it.
 * Module-level on purpose: both tours live in the same browser tab and need no React context.
 */

let holder: string | null = null

/** Take the lock. True if you now hold it (or already did); false if another tour has it. */
export function acquireTour(name: string): boolean {
  if (holder !== null && holder !== name) return false
  holder = name
  return true
}

/** Give the lock back. Only the holder can release it. */
export function releaseTour(name: string): void {
  if (holder === name) holder = null
}

export function activeTour(): string | null {
  return holder
}

export function isAnyTourActive(): boolean {
  return holder !== null
}

/** Test helper — never called by the app. */
export function __resetTourLock(): void {
  holder = null
}
