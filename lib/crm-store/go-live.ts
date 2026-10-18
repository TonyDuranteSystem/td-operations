/**
 * CRM Store — "Go live" for ONE company (master plan Part 33, dev job ad09ea91) — CLEAN LISTING (Antonio 2026-10-13).
 *
 * The company already has its reviewed, approved, CLEANED copy in the new storage (a hidden "study" storage). The old CRM
 * document records came from Drive and are messy (a tax questionnaire labelled "EIN Letter", duplicates, unsigned versions).
 * Going live makes the CRM list under the company (and its people) be exactly what is in the storage:
 *
 *   1. checks the company may switch (a copy exists, nothing mid-move, nobody mid-signing);
 *   2. takes a short lock (an open "move" run — every Drive write for the company is refused while it is open);
 *   3. every stored file gets ONE CRM record pointing at it, with the storage's clean name, type and year: an old record that
 *      already pointed at the same Drive file is reused (re-pointed and relabelled), otherwise a new one is made;
 *   4. every other old Drive record is ARCHIVED — kept for staff (nothing deleted), not shown in the CRM list, never shown to the
 *      client. A record made AFTER the copy, a workspace document and an SS-4 record are left exactly as they are;
 *   5. the client sees NOTHING from the stored files until the owner decides (file by file, in Storage) — so every record is hidden;
 *   6. proves each stored file is the approved bytes and has exactly one record — any difference undoes everything;
 *   7. only then flips the company to storage (study_only = false) and closes the lock.
 *
 * Every old value is saved to the ledger BEFORE a record changes, so `undoGoLive` puts every record, label, visibility and status
 * back and deletes the records it created. Nothing in Drive or in storage is ever deleted. Switched off unless STORE_GO_LIVE=1.
 */

import { storePointer, storeDocumentLink, isStorePointer } from "./document-pointer"

export function goLiveAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORE_GO_LIVE === "1"
}

/**
 * The REACTIVATION switch (Storage check Phase 3, slice 3a): lets the automatic step that follows a company's return to Active
 * copy that ONE company's old Drive files and switch it. It does NOT open the night run or the owner's go-live button
 * (those stay behind STORE_GO_LIVE). Anything but "1" is off.
 */
export function reactivationAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORE_REACTIVATION === "1"
}

// ───────────────────────────────────────────────────────────── pure part (unit-tested)

/** The one company that is only ever a test company (Antonio 2026-10-13: stays Drive-only). */
export const TEST_COMPANY_IDS: ReadonlySet<string> = new Set(["30c2cd96-03e4-43cf-9536-81d961b18b1d"])

/**
 * Pure: a company that never switches. Only an ACTIVE company switches; closed, cancelled, suspended, offboarding and
 * pending-formation companies stay Drive-only, and so does the test company. (Statuses verified in production 2026-10-13:
 * Active, Cancelled, Closed, Suspended, Offboarding, Pending Formation.)
 */
export function isExcludedCompany(a: { id: string; status: string | null; name?: string | null }): boolean {
  if (TEST_COMPANY_IDS.has(a.id)) return true
  if ((a.name ?? "").trim().toLowerCase() === "uxio test llc") return true
  return a.status !== "Active"
}

export interface LedgerFile {
  sourceId: string; storeFileId: string; md5?: string | null; size?: number | null
  /** sha-256 of the bytes the copy saved (what the stored file must still hold) */
  sha256?: string | null
  /** when the copy run that made this entry started — a source id in two runs uses the NEWEST */
  runStartedAt?: string | null
}
export interface CrmDocRow {
  id: string
  drive_file_id: string
  file_name: string | null
  mime_type?: string | null
  contact_id: string | null
  portal_visible: boolean | null
  service_delivery_id: string | null
  flow_stage: string | null
  created_at: string | null
}
/** A live file in the company's (or a member's) storage, with what the CRM record must say about it. */
export interface StoredFileInfo {
  id: string
  name: string
  /** the catalog document-type slug ("ein_letter_irs"), null when untyped */
  typeSlug: string | null
  typeDisplay: string | null
  legacyTypeId: number | null
  periodYear: number | null
  ownerKind: string
  ownerContactId: string | null
  categoryNum: number | null
  categoryName: string | null
  mimeType: string | null
  sizeBytes: number | null
}
export type VerdictAction = "repoint" | "archive" | "leave"
export interface RowVerdict {
  rowId: string
  action: VerdictAction
  storeFileId: string | null
  reason: string
}

/** Pure: who may NOT switch yet. Returns the plain reasons (empty = may switch). */
export function goLiveBlockers(f: {
  excluded: boolean
  ownerCount: number
  ownerIsStudy: boolean
  hasDoneCopy: boolean
  openMoveRun: boolean
  openSigning: boolean
  state: "drive" | "moving" | "store"
}): string[] {
  const out: string[] = []
  if (f.excluded) out.push("This company is closed or a test company — it stays on Drive.")
  if (f.state === "store") out.push("This company is already in the new storage.")
  if (f.state === "moving" || f.openMoveRun) out.push("A move is already open for this company.")
  if (f.ownerCount === 0) out.push("This company has no reviewed copy in the new storage yet.")
  if (f.ownerCount > 1) out.push("This company has more than one storage — cannot tell which is the approved copy.")
  if (f.ownerCount === 1 && !f.ownerIsStudy && f.state !== "store") out.push("This company's storage is not a hidden copy.")
  if (f.ownerCount >= 1 && !f.hasDoneCopy) out.push("The company's copy never finished.")
  if (f.openSigning) out.push("An SS-4 or signing request is open for this company — wait until it is signed.")
  return out
}

/**
 * Pure: decide every old CRM record.
 *   · already points at a stored file / is an SS-4 record / is a workspace document (has a service delivery or stage) → untouched;
 *   · its Drive id is in the copy ledger → it is the listing of that stored file (ONE per file: the earliest exact record wins);
 *   · made after the approved copy started → untouched (new work, staff see it as it is);
 *   · anything else (an old record the cleaning did not keep) → archived.
 * `stored` = the files that must each get a record; a file with no old record gets a new one (see `filesWithoutRecord`).
 */
export function mapRows(rows: CrmDocRow[], ledger: LedgerFile[], copyStartedAt: string | null): RowVerdict[] {
  // a Drive file copied in more than one run: the NEWEST copy wins (oldest first, later entries overwrite)
  const bySource = new Map([...ledger].sort((a, b) => (a.runStartedAt ?? "").localeCompare(b.runStartedAt ?? "")).map((l) => [l.sourceId, l]))
  const verdicts = new Map<string, RowVerdict>()
  const candidates: Array<{ row: CrmDocRow; storeFileId: string }> = []

  for (const row of rows) {
    const base = { rowId: row.id, storeFileId: null as string | null }
    if (isStorePointer(row.drive_file_id) || row.drive_file_id.startsWith("storage:")) { verdicts.set(row.id, { ...base, action: "leave", reason: "already points at a stored file" }); continue }
    if (row.drive_file_id.startsWith("ss4-")) { verdicts.set(row.id, { ...base, action: "leave", reason: "an SS-4 record (not a Drive file) — untouched" }); continue }
    const hit = bySource.get(row.drive_file_id)
    if (hit) { candidates.push({ row, storeFileId: hit.storeFileId }); continue }
    if (row.flow_stage || row.service_delivery_id) { verdicts.set(row.id, { ...base, action: "leave", reason: "a workspace document — found by its stage, untouched" }); continue }
    if (copyStartedAt && row.created_at && row.created_at > copyStartedAt) { verdicts.set(row.id, { ...base, action: "leave", reason: "made after the approved copy — stays as it is, for staff to handle" }); continue }
    verdicts.set(row.id, { ...base, action: "archive", reason: "an old record the cleaning did not keep — archived (kept for staff, not shown)" })
  }

  // one record per stored file: the earliest record of it is reused, any other record of the same file is archived
  const byFile = new Map<string, typeof candidates>()
  for (const c of candidates) byFile.set(c.storeFileId, [...(byFile.get(c.storeFileId) ?? []), c])
  for (const group of Array.from(byFile.values())) {
    const ranked = [...group].sort((a, b) =>
      // a workspace document (found by its stage) is the one that must keep pointing at the file
      Number(!!b.row.flow_stage || !!b.row.service_delivery_id) - Number(!!a.row.flow_stage || !!a.row.service_delivery_id)
      || (a.row.created_at ?? "").localeCompare(b.row.created_at ?? "")
      || a.row.id.localeCompare(b.row.id))
    ranked.forEach((c, i) => {
      verdicts.set(c.row.id, i === 0
        ? { rowId: c.row.id, action: "repoint", storeFileId: c.storeFileId, reason: "the record of this stored file" }
        : { rowId: c.row.id, action: "archive", storeFileId: c.storeFileId, reason: "a second old record of the same file — archived" })
    })
  }
  return rows.map((r) => verdicts.get(r.id) as RowVerdict)
}

/** Pure: the stored files that no old record covers (they get a new record each). `taken` = pointers some other record already uses. */
export function filesWithoutRecord(stored: StoredFileInfo[], verdicts: RowVerdict[], taken: Set<string>): StoredFileInfo[] {
  const covered = new Set(verdicts.filter((v) => v.action === "repoint" && v.storeFileId).map((v) => v.storeFileId as string))
  return stored.filter((s) => !covered.has(s.id) && !taken.has(storePointer(s.id)))
}

export interface GoLiveReport {
  accountId: string
  mayGoLive: boolean
  /** fingerprint of this plan: the real switch must be given the same value */
  planHash?: string
  blockers: string[]
  /** what the CRM list under the company becomes */
  listing: { storedFiles: number; reusedRecords: number; newRecords: number; archivedRecords: number; untouched: number }
  /** the stored files with the name/type the client-facing listing will carry (for the owner to read) */
  files: Array<{ name: string; type: string | null; year: number | null; owner: string; newRecord: boolean }>
  /** old records archived, with the reason */
  archived: Array<{ name: string | null; reason: string }>
  /** old records left exactly as they are, with the reason */
  untouched: Array<{ name: string | null; reason: string }>
}

/** Pure: the dry-run report. */
export function buildGoLiveReport(accountId: string, blockers: string[], rows: CrmDocRow[], verdicts: RowVerdict[], stored: StoredFileInfo[], newRecords: StoredFileInfo[]): GoLiveReport {
  const nameOf = new Map(rows.map((r) => [r.id, r.file_name]))
  const reused = verdicts.filter((v) => v.action === "repoint")
  const archived = verdicts.filter((v) => v.action === "archive")
  const untouched = verdicts.filter((v) => v.action === "leave" && !v.reason.startsWith("already points"))
  const isNew = new Set(newRecords.map((n) => n.id))
  return {
    accountId,
    mayGoLive: blockers.length === 0,
    blockers,
    listing: { storedFiles: stored.length, reusedRecords: reused.length, newRecords: newRecords.length, archivedRecords: archived.length, untouched: untouched.length },
    files: stored.map((s) => ({ name: s.name, type: s.typeDisplay, year: s.periodYear, owner: s.ownerKind === "person" ? "person" : "company", newRecord: isNew.has(s.id) })),
    archived: archived.map((v) => ({ name: nameOf.get(v.rowId) ?? null, reason: v.reason })),
    untouched: untouched.map((v) => ({ name: nameOf.get(v.rowId) ?? null, reason: v.reason })),
  }
}

/** Pure: a short fingerprint of what a switch would do. The real run refuses if it changed since the dry run. */
export function planFingerprint(verdicts: RowVerdict[], newRecords: StoredFileInfo[]): string {
  const text = [...verdicts.map((v) => `${v.rowId}:${v.action}:${v.storeFileId ?? ""}`), ...newRecords.map((n) => `new:${n.id}`)].sort().join("|")
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `${verdicts.length + newRecords.length}-${(h >>> 0).toString(36)}`
}

export { storePointer, storeDocumentLink }
