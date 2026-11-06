/**
 * Table cell rules for the CRM, in ONE place (dev job be097205 — "the tables do not follow the window when it shrinks").
 *
 *  1. KEEP_WHOLE — an invoice number, a date, an amount (a sign before a € or £ is a legal line-break point in Chrome), a status chip
 *     or an e-mail is never broken across two lines. Only the table's one free-text column may give way (truncate + a title).
 *  2. pinBodyCell / pinHeadCell — in a table that can scroll sideways the first (identifier) column and the Actions column stay put
 *     while the middle scrolls. Nothing is removed or hidden; on a window wide enough for the whole table they change nothing.
 *
 * The pinned cell must be OPAQUE (rows are translucent), so it paints the page surface (`bg-background`, which the CRM dark mode
 * redefines) and lays the row's own tint on top as a pseudo-element BEHIND the cell's content. The row needs the `group` class so the
 * hover tint can follow the row. Every class is written out in full on purpose: Tailwind finds classes by scanning the source text.
 */

/** Never break this cell's text across lines. */
export const KEEP_WHOLE = 'whitespace-nowrap'

export type PinSide = 'start' | 'end'

/** Row tint to mirror on a pinned body cell: 'danger' = the translucent red of an overdue row (a hovered row loses its tint, so this does too). */
export type PinTint = 'none' | 'danger'

const PIN_BASE = "sticky z-[1] bg-background before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:content-['']"
const PIN_HOVER = "after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:content-[''] after:bg-muted/30 after:opacity-0 group-hover:after:opacity-100"

const EDGE: Record<PinSide, string> = { start: 'left-0', end: 'right-0' }

/** A body cell that stays put while the table scrolls sideways. */
export function pinBodyCell(side: PinSide, tint: PinTint = 'none'): string {
  const rowTint = tint === 'danger' ? 'before:bg-red-50/50 group-hover:before:opacity-0' : ''
  return [PIN_BASE, EDGE[side], rowTint, PIN_HOVER].filter(Boolean).join(' ')
}

/** A header cell that stays put while the table scrolls sideways (the header row itself is `bg-muted/50`). */
export function pinHeadCell(side: PinSide): string {
  return [PIN_BASE, EDGE[side], 'before:bg-muted/50'].join(' ')
}
