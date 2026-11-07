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

/**
 * 'start' / 'end' = the left / right edge. 'start-after-select' = right after a 3rem (`w-12`) selection-checkbox column that is itself
 * pinned with 'start' (Portal launch): the identifier column then sits next to the checkbox instead of on top of it.
 */
export type PinSide = 'start' | 'end' | 'start-after-select'

/**
 * Row tint to mirror on a pinned body cell: 'danger' = the translucent red of an overdue row (a hovered row loses its tint, so this does too);
 * 'zinc' = the light grey of an opened (expanded) row; 'blue' = the light blue of a selected (ticked) row.
 */
export type PinTint = 'none' | 'danger' | 'zinc' | 'blue'

/**
 * What the table sits on. 'page' = straight on the page (`bg-background`); 'card' = inside a white card (`bg-white`, which the CRM dark mode
 * maps to the card colour). A pinned cell must paint the SAME surface as the box around the table, or it shows as a patch in dark mode.
 */
export type PinSurface = 'page' | 'card'

/** The header row's own tint, so a pinned header cell matches the rest of the header. */
export type PinHeadTint = 'muted-50' | 'muted-40' | 'zinc-50' | 'gray-50' | 'slate-50' | 'none'

const PIN_BASE = "sticky z-[1] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:content-['']"
const PIN_HOVER = "after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:content-[''] after:bg-muted/30 after:opacity-0 group-hover:after:opacity-100"

const EDGE: Record<PinSide, string> = { start: 'left-0', end: 'right-0', 'start-after-select': 'left-12' }
const SURFACE: Record<PinSurface, string> = { page: 'bg-background', card: 'bg-white' }
const ROW_TINT: Record<PinTint, string> = {
  none: '',
  danger: 'before:bg-red-50/50 group-hover:before:opacity-0',
  zinc: 'before:bg-zinc-50',
  blue: 'before:bg-blue-50',
}
const HEAD_TINT: Record<PinHeadTint, string> = {
  'muted-50': 'before:bg-muted/50',
  'muted-40': 'before:bg-muted/40',
  'zinc-50': 'before:bg-zinc-50',
  'gray-50': 'before:bg-gray-50',
  'slate-50': 'before:bg-slate-50',
  none: '', // a header with no tint of its own: the pinned cell just paints the surface
}

/** A body cell that stays put while the table scrolls sideways. */
export function pinBodyCell(side: PinSide, tint: PinTint = 'none', surface: PinSurface = 'page'): string {
  return [PIN_BASE, SURFACE[surface], EDGE[side], ROW_TINT[tint], PIN_HOVER].filter(Boolean).join(' ')
}

/** A header cell that stays put while the table scrolls sideways (default: the Finance header, `bg-muted/50` on the page). */
export function pinHeadCell(side: PinSide, headTint: PinHeadTint = 'muted-50', surface: PinSurface = 'page'): string {
  return [PIN_BASE, SURFACE[surface], EDGE[side], HEAD_TINT[headTint]].filter(Boolean).join(' ')
}
