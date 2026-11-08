/**
 * The result panel of an approved tax questionnaire: is it SAVED in the company's storage, still SAVING, or FAILED — and if it failed,
 * why and what to do (dev job 7df278cd, Shipment 2). The pure core: no database, no network. The wording follows the approved mockup.
 *
 * Where the facts come from: the save job (`archive_tax_submission`, lib/tax/archive-submission.ts) writes its bookkeeping into the
 * submission's `drive_archive_meta`; the marker `drive_archived_at` says "the CURRENT answers are saved" (it is cleared again when the
 * client resubmits changed answers, see lib/tax/save-rules in wizard-submit). Everything here only READS that record.
 */

/**
 * The bookkeeping reset when the client resubmits changed answers: a fresh round gets fresh tries and a fresh alert. `sweep_alerted`
 * goes back to EMPTY (null), not false: the sweep's filter reads "empty", and the banking twin resets it to null too — a stored
 * `false` reads as "already alerted" to that filter.
 */
export const SAVE_RESET_META = { attempts: 0, last_error: null, failed: [], errors: [], sweep_alerted: null } as const

export type EarlierCopyChoice = "hidden" | "visible"

export interface SaveMeta {
  attempts: number
  lastError: string | null
  failed: string[]
  errors: string[]
  filedIn: string | null
  /** the saved summary file, as the store pointer the save job recorded ("store:<file id>") */
  summaryPointer: string | null
  /** the time printed on the saved PDF, pinned to the answers it was made for (so a retry of the same answers makes the same file) */
  stamp: { fp: string; at: string } | null
  /** what staff chose about the earlier copies, and how many earlier copies existed when they chose */
  earlierCopy: { choice: EarlierCopyChoice; covered: number; at: string; by: string } | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []
}

/** Read the stored record defensively: anything unexpected reads as "nothing recorded". */
export function readSaveMeta(raw: unknown): SaveMeta {
  const m = isRecord(raw) ? raw : {}
  const attempts = Number(m.attempts)
  const stamp = isRecord(m.stamp) && typeof m.stamp.fp === "string" && typeof m.stamp.at === "string" ? { fp: m.stamp.fp, at: m.stamp.at } : null
  const ec = isRecord(m.earlier_copy) ? m.earlier_copy : null
  const earlierCopy =
    ec && (ec.choice === "hidden" || ec.choice === "visible") && Number.isFinite(Number(ec.covered))
      ? { choice: ec.choice as EarlierCopyChoice, covered: Math.max(0, Math.floor(Number(ec.covered))), at: typeof ec.at === "string" ? ec.at : "", by: typeof ec.by === "string" ? ec.by : "" }
      : null
  return {
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
    lastError: typeof m.last_error === "string" && m.last_error !== "" ? m.last_error : null,
    failed: strings(m.failed),
    errors: strings(m.errors),
    filedIn: typeof m.filed_in === "string" ? m.filed_in : null,
    summaryPointer: typeof m.summary_file_id === "string" && m.summary_file_id !== "" ? m.summary_file_id : null,
    stamp,
    earlierCopy,
  }
}

// ─── Why a save failed ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SaveFailureKind = "no_storage" | "summary" | "files" | "changed" | "unreachable"

/** The marker the save job raises when the client changed the answers while it was saving (see archive-submission.ts). */
export const ANSWERS_CHANGED_MESSAGE = "the client changed the answers while they were being saved"

export function classifyFailure(m: Pick<SaveMeta, "lastError" | "failed" | "errors">): SaveFailureKind {
  const text = [m.lastError, ...m.errors].filter(Boolean).join(" | ")
  if (/no storage and no folder/i.test(text)) return "no_storage"
  if (text.includes(ANSWERS_CHANGED_MESSAGE)) return "changed"
  if (/summary pdf/i.test(text)) return "summary"
  if (m.failed.length > 0 || /file\(s\) failed/i.test(text)) return "files"
  return "unreachable"
}

/** "Payset statements 2025.pdf (download failed after 3 attempts)" / "name.pdf: <error>" → "Payset statements 2025.pdf" */
export function failedFileName(entry: string): string {
  return entry.replace(/\s*\(download failed.*$/i, "").split(": ")[0].trim()
}

export function failureText(kind: SaveFailureKind, failedFiles: string[]): { reason: string; fix: string } {
  switch (kind) {
    case "no_storage":
      return { reason: "This company has no storage yet.", fix: "Open the company's Storage tab and create it, then press Retry saving." }
    case "summary":
      return { reason: "The summary PDF could not be created.", fix: "Press Retry saving. The answers are still safe in the job." }
    case "files": {
      const names = failedFiles.map(failedFileName)
      const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "")
      return {
        reason: `${names.length === 1 ? "1 of the client's files" : `${names.length} of the client's files`} could not be copied${shown ? `: ${shown}` : ""}.`,
        fix: "Ask the client to upload it again, then press Retry saving.",
      }
    }
    case "changed":
      return { reason: "The client changed the answers while they were being saved.", fix: "Press Retry saving." }
    default:
      return { reason: "Storage did not answer.", fix: "Nothing to fix. Press Retry saving to try again." }
  }
}

// ─── The state ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LiveJob = "none" | "pending" | "processing"

export type SaveState =
  | { state: "not_released" }
  | { state: "not_needed"; reason: string }
  | { state: "saved" }
  | { state: "saving" }
  | { state: "not_saved" }
  | { state: "failed"; kind: SaveFailureKind; reason: string; fix: string; attempts: number; retrying: boolean }

export const CLOSED_COMPANY_NOTHING_TO_FILE = "This company is closed, so there is nothing to file. The approval is recorded; the answers stay on the job."

export function decideSaveState(i: { reviewStatus: string | null; archivedAt: string | null; meta: SaveMeta; job: LiveJob; finished: boolean }): SaveState {
  // The panel is about the APPROVED answers: before staff approve, nothing is promised.
  if (i.reviewStatus !== "confirmed") return { state: "not_released" }
  if (i.archivedAt) return i.meta.filedIn === "nothing" ? { state: "not_needed", reason: CLOSED_COMPANY_NOTHING_TO_FILE } : { state: "saved" }
  if (i.finished) return { state: "not_needed", reason: CLOSED_COMPANY_NOTHING_TO_FILE }
  if (i.job === "processing") return { state: "saving" }
  if (i.meta.attempts > 0 && i.meta.lastError) {
    const kind = classifyFailure(i.meta)
    return { state: "failed", kind, ...failureText(kind, i.meta.failed), attempts: i.meta.attempts, retrying: i.job === "pending" }
  }
  return { state: "not_saved" }
}

// ─── Earlier copies ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FileVersionLite {
  id: string
  versionNo: number
  createdAt: string
  current: boolean
}

/**
 * The "what should we do with the earlier copies?" card. It lists only the earlier copies staff have not yet chosen for: a later
 * resubmit makes a new earlier copy (the one that was current), and the card comes back for just that one. Versions only ever
 * get appended, so "the first `covered` earlier copies" are exactly the ones the last choice was about.
 */
export function earlierCopiesToDecide(versions: FileVersionLite[], choice: SaveMeta["earlierCopy"]): FileVersionLite[] {
  const earlier = versions.filter((v) => !v.current).sort((a, b) => a.versionNo - b.versionNo)
  return earlier.slice(choice ? choice.covered : 0)
}

/** "Tax_Data_Acme.pdf" + version 2 → "Tax_Data_Acme (version 2).pdf" */
export function earlierCopyName(fileName: string, versionNo: number): string {
  const dot = fileName.lastIndexOf(".")
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ""
  return `${stem} (version ${versionNo})${ext}`
}

/** The newest history entry that released the submission (Approve): who and when. `by` is empty when it was not a person's name. */
export function approvedBy(history: unknown): { at: string; by: string } | null {
  if (!Array.isArray(history)) return null
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (isRecord(h) && h.to === "confirmed" && typeof h.at === "string") {
      const by = typeof h.by === "string" ? h.by : ""
      return { at: h.at, by: by === "flow-action" || by === "" ? "" : by }
    }
  }
  return null
}
