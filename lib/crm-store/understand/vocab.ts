/**
 * File Understanding — the fixed words this layer uses (job 685467b5). They live in CODE, not in CHECK constraints,
 * so adding one never needs a migration. Anything about DOCUMENT TYPES stays in the catalog (`storage_document_types`).
 */

/** Bump when the reading or the judging changes in a way that could change an answer. Old rows are kept. */
export const ANALYZER_VERSION = "u1"

export type AnalysisStatus = "read" | "partial" | "unreadable" | "failed" | "judged"
export type Verdict = "green" | "red"
export type DuplicateKind = "same_bytes" | "same_words" | "different_words"

/** Hard ceilings so one odd file can never take the server down (an out-of-memory is not catchable). */
export const LIMITS = {
  /** never download or read a stored file bigger than this */
  maxFileBytes: 50 * 1024 * 1024,
  /** the most pages ever read from one document */
  maxPages: 60,
  /** zip: most entries listed, most bytes ever inflated, biggest text member decoded */
  zipMaxEntries: 300,
  zipMaxUncompressedBytes: 100 * 1024 * 1024,
  zipMaxMemberBytes: 2 * 1024 * 1024,
  zipMaxRatio: 200,
  /** a text/CSV file is kept whole up to this, never silently cut */
  maxTextBytes: 8 * 1024 * 1024,
  /** the biggest image sent to the AI */
  maxVisionBytes: 4 * 1024 * 1024,
} as const

/** Reasons a file is RED — shown to staff in plain words. */
export const RED_REASON_TEXT: Record<string, string> = {
  unreadable: "The file could not be read.",
  partly_read: "Only part of the file could be read.",
  no_words: "No words were found in the file.",
  new_type: "The AI suggests a type that is not in the list yet.",
  no_type: "The AI could not tell what this is.",
  crm_disagrees: "The CRM record says something different.",
  crm_none: "There is no CRM record to check it against.",
  no_example: "No confirmed example of this kind yet.",
  example_disagrees: "Past corrections point to a different type.",
  wrong_client: "It may belong to another client.",
  duplicate_differs: "It looks like another file but the words differ.",
  injection: "The file's text tried to give the AI instructions.",
  ai_failed: "The AI could not be reached.",
  bad_name: "The suggested name would have contained an ID or tax number.",
}
