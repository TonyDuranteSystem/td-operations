/**
 * Files the worker PRODUCED, as the panels read them off an API response.
 *
 * PURE + JSX-FREE ON PURPOSE. The renderer lives in
 * `components/chat/worker-artifacts.tsx`; this half is the parsing rule, split out
 * so it can be unit-tested directly (a plain vitest unit test cannot import a
 * component module) and so all three worker panels — Inbox, Portal Chats, the CRM
 * sidebar — validate the payload identically. Antonio, 2026-08-05: "must be able
 * to produce files everywhere."
 *
 * WHY VALIDATION EXISTS AT ALL: the parsed entries become real `<a href>` download
 * buttons. A malformed entry must be DROPPED, never rendered — a button that goes
 * nowhere is worse than no button, and it recreates the exact false-capability
 * failure this feature was built to remove (the worker announcing a file with
 * nothing behind it).
 */

/** One file the worker produced this turn, as the server reports it. */
export interface WorkerArtifactLink {
  /** "pdf" | "spreadsheet" — used only to pick an icon; an unknown value is fine. */
  kind: string
  /** Time-limited signed link. Expires; never a permanent public URL. */
  url: string
  label: string
}

/**
 * Read the artifact list off a worker API response, defensively.
 *
 * Every non-conforming shape reaches this in real life: an older deployment that
 * does not send the field, an error body, a timeout, a turn that produced nothing.
 * All of them must come back as an empty list rather than throwing inside a render.
 */
export function parseWorkerArtifacts(raw: unknown): WorkerArtifactLink[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (a): a is WorkerArtifactLink =>
      !!a &&
      typeof a === "object" &&
      typeof (a as WorkerArtifactLink).url === "string" &&
      (a as WorkerArtifactLink).url.length > 0 &&
      typeof (a as WorkerArtifactLink).label === "string",
  )
}
