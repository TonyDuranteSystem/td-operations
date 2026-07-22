/**
 * Calendar maths for the Notes tab. Pure — no DB, no React — so the day-bucketing rules are
 * unit-tested rather than eyeballed in a month grid.
 *
 * A note lands on the day it COMES BACK (its snooze instant). That is the only date a note has,
 * and in Antonio's model it is the real one: the screen shows what's live now, the Notes tab
 * shows everything, and the calendar answers "what comes back when".
 *
 * Bucketing is by LOCAL day, deliberately. The stored instant is UTC; a note set for 9am local
 * would land on the previous/next day if bucketed in UTC. Every helper takes dates the caller
 * built locally.
 */

export interface CalendarNoteLike {
  id: string
  snoozed_until: string | null
  archived_at: string | null
}

/** Local YYYY-MM-DD for a Date — the grid's cell key. Never use toISOString() here (that's UTC). */
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** The day a note belongs on, or null if it has no come-back date / is done. */
export function noteDayKey(note: CalendarNoteLike): string | null {
  if (note.archived_at) return null // done notes live in the List view, not the calendar
  if (!note.snoozed_until) return null // no date set — it's on screen now, not scheduled
  const d = new Date(note.snoozed_until)
  if (isNaN(d.getTime())) return null
  return localDayKey(d)
}

/** Group notes by their local day. Notes with no day are returned separately, never dropped. */
export function groupNotesByDay<T extends CalendarNoteLike>(
  notes: T[],
): { byDay: Map<string, T[]>; undated: T[] } {
  const byDay = new Map<string, T[]>()
  const undated: T[] = []
  for (const n of notes) {
    const key = noteDayKey(n)
    if (!key) {
      // archived notes are simply out of scope for the calendar; undated LIVE notes are the
      // ones worth surfacing as "no date yet"
      if (!n.archived_at) undated.push(n)
      continue
    }
    const list = byDay.get(key)
    if (list) list.push(n)
    else byDay.set(key, [n])
  }
  return { byDay, undated }
}

export interface MonthCell {
  key: string // local YYYY-MM-DD
  date: Date
  inMonth: boolean // false for the leading/trailing days that pad the grid
  isToday: boolean
}

/**
 * The 6x7 cell grid for a month, weeks starting MONDAY (European — Antonio is in Italy).
 * Always 42 cells so the grid never changes height as you page through months.
 */
export function buildMonthGrid(year: number, monthIndex: number, today: Date): MonthCell[] {
  const first = new Date(year, monthIndex, 1)
  // JS getDay(): 0=Sun..6=Sat. Shift so Monday=0.
  const leading = (first.getDay() + 6) % 7
  const start = new Date(year, monthIndex, 1 - leading)
  const todayKey = localDayKey(today)

  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    cells.push({
      key: localDayKey(d),
      date: d,
      inMonth: d.getMonth() === monthIndex && d.getFullYear() === year,
      isToday: localDayKey(d) === todayKey,
    })
  }
  return cells
}

/** Step a year/month pair by whole months, rolling the year correctly. */
export function shiftMonth(year: number, monthIndex: number, delta: number): { year: number; monthIndex: number } {
  const d = new Date(year, monthIndex + delta, 1)
  return { year: d.getFullYear(), monthIndex: d.getMonth() }
}

/** A note whose come-back time has passed and which is still live — it came back and is waiting. */
export function isOverdue(note: CalendarNoteLike, now: Date): boolean {
  if (note.archived_at || !note.snoozed_until) return false
  const d = new Date(note.snoozed_until)
  if (isNaN(d.getTime())) return false
  return d.getTime() < now.getTime()
}

/** Month label for the header, in the viewer's locale. */
export function monthLabel(year: number, monthIndex: number): string {
  return new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })
}
