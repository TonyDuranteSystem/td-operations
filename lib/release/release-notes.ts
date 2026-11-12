/**
 * Releases — what each release of the CRM does, in plain English (dev job 616dc839, Antonio 2026-11-11).
 *
 * WHY: the "New release available — refresh" bar (job dc629a3d) only said THAT a release exists. Staff could not tell what it changes.
 * Here every release carries a small note (content/releases/<id>.json) written by the session that made the change. The notes are
 * compiled INTO each build (next.config.js → scripts/release-notes-env.js), so the live site can describe a release without a database,
 * and the description always matches the exact build it ships with. The bar offers "See what's new" before anyone refreshes, and the
 * Releases page keeps the whole history.
 *
 * A note's id is its file name: `YYYY-MM-DD-HHMM-short-name` (UTC). Ids sort in time order; a note newer than the one a page was built
 * with is a note that page has not seen. Pure functions only — no database, no files (the build reads the files).
 */

export const NOTE_TAGS = ['new', 'improved', 'fixed', 'behind-the-scenes'] as const
export type NoteTag = (typeof NOTE_TAGS)[number]

export const NOTE_TAG_LABEL: Record<NoteTag, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  'behind-the-scenes': 'Behind the scenes',
}

export interface ReleaseNote {
  /** The file name without `.json`: `2026-11-11-1934-zoom-call-folders`. */
  id: string
  title: string
  tag: NoteTag
  /** Plain English for the team: what this release does and where to see it. */
  text: string
  /** Optional short lines ("what to try"). */
  points: string[]
  /** Optional picture file in public/release-notes/ (sandbox test data only — never a real client). */
  screenshot: string | null
}

export const NOTE_TITLE_MAX = 100
export const NOTE_TEXT_MAX = 700
export const NOTE_POINTS_MAX = 6
export const NOTE_POINT_MAX = 220
/** How many notes the "See what's new" panel carries at most (the rest are counted, and live on the Releases page). */
export const PANEL_NOTES_MAX = 25

export const NOTE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SCREENSHOT_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp)$/

export const isNoteId = (v: unknown): v is string => typeof v === 'string' && NOTE_ID_PATTERN.test(v)
export const isNoteTag = (v: unknown): v is NoteTag => typeof v === 'string' && (NOTE_TAGS as readonly string[]).includes(v)
export const isHiddenNote = (n: Pick<ReleaseNote, 'tag'>): boolean => n.tag === 'behind-the-scenes'

/** Where a note's picture is served from. */
export const screenshotUrl = (file: string): string => `/release-notes/${file}`

/** Every problem with a raw note (empty = fine). The unit test runs this over every real file so a broken note never reaches main. */
export function noteProblems(id: unknown, raw: unknown): string[] {
  const problems: string[] = []
  if (!isNoteId(id)) problems.push('the file name must look like 2026-11-11-1934-short-name (UTC time, lower case, dashes)')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [...problems, 'the file must hold one JSON object']
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  if (!title) problems.push('title is empty')
  if (title.length > NOTE_TITLE_MAX) problems.push(`title is longer than ${NOTE_TITLE_MAX} characters`)
  if (!isNoteTag(r.tag)) problems.push(`tag must be one of: ${NOTE_TAGS.join(', ')}`)
  if (!text) problems.push('text is empty')
  if (text.length > NOTE_TEXT_MAX) problems.push(`text is longer than ${NOTE_TEXT_MAX} characters`)
  if (r.points !== undefined) {
    if (!Array.isArray(r.points)) problems.push('points must be a list of short lines')
    else {
      if (r.points.length > NOTE_POINTS_MAX) problems.push(`more than ${NOTE_POINTS_MAX} points`)
      for (const p of r.points) {
        if (typeof p !== 'string' || !p.trim()) problems.push('a point is empty')
        else if (p.length > NOTE_POINT_MAX) problems.push(`a point is longer than ${NOTE_POINT_MAX} characters`)
      }
    }
  }
  if (r.screenshot !== undefined && r.screenshot !== null && (typeof r.screenshot !== 'string' || !SCREENSHOT_PATTERN.test(r.screenshot))) {
    problems.push('screenshot must be a plain file name (png, jpg or webp) from public/release-notes/')
  }
  return problems
}

/** A raw note → a clean one, or null if it has any problem. */
export function parseNote(id: unknown, raw: unknown): ReleaseNote | null {
  if (noteProblems(id, raw).length > 0) return null
  const r = raw as Record<string, unknown>
  return {
    id: id as string,
    title: (r.title as string).trim(),
    tag: r.tag as NoteTag,
    text: (r.text as string).trim(),
    points: Array.isArray(r.points) ? (r.points as string[]).map(p => p.trim()) : [],
    screenshot: typeof r.screenshot === 'string' ? r.screenshot : null,
  }
}

const byIdAscending = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The build's baked list (an array of `{ id, ...note }` as JSON text) → clean notes, oldest first. Anything unreadable or invalid is
 * dropped, never thrown: a damaged note must not take the page down (the unit test is what keeps it out of main).
 */
export function parseNotesJson(json: string | undefined | null): ReleaseNote[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const seen = new Set<string>()
    const out: ReleaseNote[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const { id, ...rest } = item as Record<string, unknown>
      if (typeof id !== 'string' || seen.has(id)) continue
      const note = parseNote(id, rest)
      if (!note) continue
      seen.add(id)
      out.push(note)
    }
    return out.sort(byIdAscending)
  } catch {
    return []
  }
}

/** Newest first (the order a person reads). */
export const newestFirst = (notes: readonly ReleaseNote[]): ReleaseNote[] => [...notes].sort((a, b) => byIdAscending(b, a))

/**
 * What the "See what's new" panel shows a page that was built when `since` was the newest note: every note newer than that, newest
 * first, without the behind-the-scenes ones. No usable `since` (a page built before notes existed, a damaged value) → nothing: it is
 * never "everything", which would bury the one thing that changed.
 */
export function notesForPanel(notes: readonly ReleaseNote[], since: unknown): { notes: ReleaseNote[]; more: number } {
  if (!isNoteId(since)) return { notes: [], more: 0 }
  const fresh = newestFirst(notes).filter(n => n.id > since && !isHiddenNote(n))
  return { notes: fresh.slice(0, PANEL_NOTES_MAX), more: Math.max(0, fresh.length - PANEL_NOTES_MAX) }
}

/** The moment a note was written (its id is UTC), or null for a malformed id. */
export function noteMoment(id: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-/.exec(id)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])))
  return Number.isNaN(d.getTime()) ? null : d
}

/** "Wed, Nov 11" in the team's time (New York), for grouping and for each card. */
export function noteDayLabel(id: string): string {
  const d = noteMoment(id)
  if (!d) return ''
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}
