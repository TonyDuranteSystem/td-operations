/**
 * Which documents the CRM account "Documents" tab must render in its FLAT list.
 *
 * WHY THIS EXISTS (Luca, td-bug 2026-07-20; dev job 527b2377):
 * The Documents tab renders AccountDocumentsList (a flat list) ABOVE FileManager
 * (the Google Drive folder tree). The flat list was added 2026-06-20 so that
 * Storage-fallback uploads — which have no Drive file and therefore cannot
 * appear in the folder tree — are visible at all. But it listed EVERY documents
 * row unconditionally, so any Drive-backed document rendered TWICE: once flat,
 * once in its folder. That double-listing is what Luca reported.
 *
 * The rule is not "hide storage documents" — it is "the flat list carries only
 * what has nowhere else to appear". A document has no other home when EITHER:
 *
 *  1. its pointer is not a real Drive file id — a sentinel like `storage:<path>`
 *     (Supabase Storage fallback) or `ss4-live:<token>` (live-rendered SS-4), or
 *     it is missing entirely; OR
 *  2. the account has no Drive folder at all — FileManager then renders only its
 *     "No Google Drive folder" empty state, so even a Drive-backed row would be
 *     invisible if the flat list dropped it.
 *
 * Case 2 is why this takes `accountHasDriveFolder`. A council reviewer flagged
 * that a sentinel-only filter would make that class invisible in BOTH views. A
 * production count for that class was 0 at the time of writing, but this is
 * handled BY CONSTRUCTION rather than by relying on that snapshot staying 0.
 *
 * Sentinel detection is deliberately "contains a colon" rather than an explicit
 * list of known prefixes: a Google Drive file id never contains one, so any
 * future `something:` sentinel is covered without editing this file.
 */

export interface DocumentPointer {
  drive_file_id?: string | null
}

/**
 * True when this document cannot be rendered by the Drive folder view, and so
 * must appear in the flat list.
 */
export function needsFlatListing(
  doc: DocumentPointer,
  accountHasDriveFolder: boolean,
): boolean {
  // No Drive folder on the account → the folder tree shows nothing at all.
  if (!accountHasDriveFolder) return true

  const id = doc.drive_file_id
  if (id === null || id === undefined) return true
  const trimmed = id.trim()
  if (!trimmed) return true

  // Any `prefix:rest` pointer is a sentinel, not a Drive file id.
  return trimmed.includes(":")
}

/**
 * Narrow a document list to those with no other place to appear. Preserves the
 * caller's ordering.
 */
export function filterDocumentsNeedingFlatListing<T extends DocumentPointer>(
  documents: T[] | null | undefined,
  accountHasDriveFolder: boolean,
): T[] {
  if (!documents || documents.length === 0) return []
  return documents.filter(doc => needsFlatListing(doc, accountHasDriveFolder))
}
