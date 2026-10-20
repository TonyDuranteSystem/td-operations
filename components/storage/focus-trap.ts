/** Keeps Tab inside a modal window (shared by the required save-where window and the folder picker inside it). */

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Pure: where Tab goes inside the window — Tab on the last control wraps to the first, Shift+Tab on the first wraps to the last (null = let the browser move on inside). */
export function trapTarget<T>(controls: T[], active: T | null, shift: boolean): T | null {
  if (controls.length === 0) return null
  const first = controls[0], last = controls[controls.length - 1]
  if (active === null || !controls.includes(active)) return shift ? last : first   // focus is outside the window: bring it in
  if (shift && active === first) return last
  if (!shift && active === last) return first
  return null
}

/** A React onKeyDown for the root of a modal: Tab wraps inside it. Does nothing when an inner modal already handled the key. */
export function trapTabKey(e: { key: string; shiftKey: boolean; defaultPrevented?: boolean; preventDefault: () => void; currentTarget: { querySelectorAll: (s: string) => ArrayLike<unknown> } }): void {
  if (e.key !== 'Tab' || e.defaultPrevented) return
  const controls = Array.from(e.currentTarget.querySelectorAll(FOCUSABLE)) as Array<{ focus: () => void }>
  const active = (typeof document !== 'undefined' ? (document.activeElement as unknown as { focus: () => void } | null) : null) ?? null
  const to = trapTarget(controls, active, e.shiftKey)
  if (to) { e.preventDefault(); to.focus() }
}
