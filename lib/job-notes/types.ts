/**
 * Calendar team notes — the pure part (dev job 388bb74b). One small append-only list of dated notes per job; nothing is overwritten.
 * Client-safe: no database, no server code.
 */
export const NOTE_MAX = 4000
export const PREVIEW_MAX = 110

export interface JobNote {
  id: string
  body: string
  authorName: string
  /** ISO time */
  createdAt: string
}

/** What a Calendar row shows: how many notes, and the newest one. */
export interface NoteSummary {
  count: number
  last: JobNote | null
}

// (a plain shape, not a union: this project's compiler settings do not narrow unions)
export interface NoteBodyResult { ok: boolean; body?: string; error?: string }

/** PURE: the text to save, or the plain reason it cannot be saved. */
export function checkNoteBody(raw: unknown): NoteBodyResult {
  if (typeof raw !== "string") return { ok: false, error: "Write the note first." }
  const body = raw.replace(/\r\n/g, "\n").trim()
  if (!body) return { ok: false, error: "Write the note first." }
  if (body.length > NOTE_MAX) return { ok: false, error: `That note is too long (${body.length} characters; the limit is ${NOTE_MAX}).` }
  return { ok: true, body }
}

/** PURE: one line of the note for the row ("Luca: waiting on DHL..."). */
export function notePreview(note: JobNote): string {
  const oneLine = note.body.replace(/\s+/g, " ").trim()
  const cut = oneLine.length > PREVIEW_MAX ? `${oneLine.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : oneLine
  const who = (note.authorName || "").trim().split(/\s+/)[0]
  return who ? `${who}: ${cut}` : cut
}

/** PURE: "Oct 21, 6:40 PM" in New York time. */
export function noteTimeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(d)
}

/** PURE: the author name stored with a note, from the signed-in user (never from the browser). */
export function authorNameOf(user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined): string {
  const meta = user?.user_metadata ?? {}
  const full = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : ""
  if (full.trim()) return full.trim().slice(0, 80)
  const local = (user?.email ?? "").split("@")[0]
  return (local || "Team").slice(0, 80)
}

/** PURE: fold a flat, newest-first list of notes into one summary per job. */
export function summariseNotes(notes: Array<JobNote & { jobId: string }>): Map<string, NoteSummary> {
  const out = new Map<string, NoteSummary>()
  for (const n of notes) {
    const s = out.get(n.jobId)
    if (!s) out.set(n.jobId, { count: 1, last: { id: n.id, body: n.body, authorName: n.authorName, createdAt: n.createdAt } })
    else {
      s.count += 1
      if (s.last && n.createdAt > s.last.createdAt) s.last = { id: n.id, body: n.body, authorName: n.authorName, createdAt: n.createdAt }
    }
  }
  return out
}
