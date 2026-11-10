/**
 * Scan document: which side of its button the attach menu opens on. The menu prefers the side the caller asked for
 * (above a message box at the bottom of the screen, below a row near the top of a dialog) but flips when that side
 * has too little room — the phone app's Reply screen scrolls under a header, and an upward menu there ran off the top
 * and lost its first row ("Scan document"). Pure maths, tested without a browser.
 */
export type MenuSide = 'above' | 'below'

/**
 * `spaceAbove` / `spaceBelow` = free pixels between the button and the edge of whatever would cut the menu off
 * (the scrolling area it sits in, or the screen). `menuHeight` = how tall the menu is. `gap` = breathing room.
 */
export function chooseMenuSide(preferred: MenuSide, spaceAbove: number, spaceBelow: number, menuHeight: number, gap = 12): MenuSide {
  const need = menuHeight + gap
  const room = (side: MenuSide) => (side === 'above' ? spaceAbove : spaceBelow)
  const other: MenuSide = preferred === 'above' ? 'below' : 'above'
  if (room(preferred) >= need) return preferred
  // the preferred side is too tight: use the other one if it is roomier, else stay
  return room(other) > room(preferred) ? other : preferred
}

/** The nearest ancestor that would cut off something drawn outside it (a scrolling or clipping box), or null for the screen. */
export function nearestClippingAncestor(el: Element | null): Element | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p)
    if (/(auto|scroll|hidden|clip)/.test(o.overflowY)) return p
  }
  return null
}
