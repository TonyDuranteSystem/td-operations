/**
 * CRM Store — "Go live" for ONE company (master plan Part 33, dev job ad09ea91).
 *
 * The company already has its reviewed, approved COPY in the new storage (a "study" storage, hidden). Going live does
 * NOT copy or review anything again. It links the CRM to that copy and then flips the company to "storage":
 *
 *   1. checks the company may switch (a copy exists, nothing mid-move, nobody mid-signing);
 *   2. takes a short lock (an open "move" run — every Drive write for the company is refused while it is open);
 *   3. maps each CRM document record to its stored file: EXACT (the record's Drive id is in the copy ledger) or TWIN
 *      (a different Drive file with the same bytes — same checksum + size); anything else stays on Drive;
 *   4. re-points each mapped record (the OLD link is written to the ledger first, so a stopped run can always be undone).
 *      One record per stored file (a database rule): the record the CLIENT sees wins; a duplicate record stays on Drive;
 *   5. proves the client can still open everything they could open before — any difference undoes everything;
 *   6. only then flips the company to storage (study_only = false) and closes the lock.
 *
 * Nothing in Drive is changed or deleted. The whole thing is one idempotent, per-company operation and is undone by
 * `undoGoLive` (records put back, company back to hidden study copy). Switched off unless STORE_GO_LIVE=1.
 */

import { storePointer, storeDocumentLink, isStorePointer } from "./document-pointer"
import { shownToClientByRow } from "@/lib/portal/client-store-docs"

export function goLiveAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORE_GO_LIVE === "1"
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

export interface LedgerFile { sourceId: string; storeFileId: string; md5: string | null; size: number | null }
export interface CrmDocRow {
  id: string
  drive_file_id: string
  file_name: string | null
  contact_id: string | null
  portal_visible: boolean | null
  service_delivery_id: string | null
  flow_stage: string | null
  created_at: string | null
}
export type Via = "exact" | "twin"
export interface RowVerdict {
  rowId: string
  action: "repoint" | "leave" | "catchup"
  via: Via | null
  storeFileId: string | null
  clientSees: boolean
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
  if (f.openSigning) out.push("A signing or SS-4 is open for this company — wait until it is signed.")
  return out
}

/**
 * Pure: decide every record. `twins` = rows whose bytes match a different ledger file (computed from Drive checksums).
 * One record per stored file: the client-visible record wins, then an exact match over a twin, then the oldest.
 */
export function mapRows(
  rows: CrmDocRow[],
  ledger: LedgerFile[],
  twins: Map<string, LedgerFile>,
  serviceTypeOf: (serviceDeliveryId: string | null) => string | null,
  /** records the CRM made AFTER the approved copy (created later than this) are brought in one file at a time */
  catchUpAfter: string | null = null,
): RowVerdict[] {
  const bySource = new Map(ledger.map((l) => [l.sourceId, l]))
  const verdicts = new Map<string, RowVerdict>()
  const candidates: Array<{ row: CrmDocRow; file: LedgerFile; via: Via; clientSees: boolean }> = []

  for (const row of rows) {
    const clientSees = shownToClientByRow({ portalVisible: row.portal_visible, serviceType: serviceTypeOf(row.service_delivery_id), flowStage: row.flow_stage })
    const base = { rowId: row.id, clientSees, via: null as Via | null, storeFileId: null as string | null }
    if (isStorePointer(row.drive_file_id) || row.drive_file_id.startsWith("storage:")) {
      verdicts.set(row.id, { ...base, action: "leave", reason: "already points at a stored file" })
      continue
    }
    const exact = bySource.get(row.drive_file_id)
    if (exact) { candidates.push({ row, file: exact, via: "exact", clientSees }); continue }
    const twin = twins.get(row.id)
    if (twin) { candidates.push({ row, file: twin, via: "twin", clientSees }); continue }
    // a person's own record can be linked to the person's stored file (exact/twin), but is never "caught up" here
    if (!row.contact_id && catchUpAfter && row.created_at && row.created_at > catchUpAfter) {
      verdicts.set(row.id, { ...base, action: "catchup", reason: "recorded after the approved copy — brought in one file at a time" })
      continue
    }
    verdicts.set(row.id, { ...base, action: "leave", reason: "not in the approved copy — stays on Drive" })
  }

  // one record per stored file
  const byFile = new Map<string, typeof candidates>()
  for (const c of candidates) byFile.set(c.file.storeFileId, [...(byFile.get(c.file.storeFileId) ?? []), c])
  for (const group of Array.from(byFile.values())) {
    const ranked = [...group].sort((a, b) =>
      Number(b.clientSees) - Number(a.clientSees)
      || Number(b.via === "exact") - Number(a.via === "exact")
      || (a.row.created_at ?? "").localeCompare(b.row.created_at ?? "")
      || a.row.id.localeCompare(b.row.id))
    ranked.forEach((c, i) => {
      verdicts.set(c.row.id, i === 0
        ? { rowId: c.row.id, action: "repoint", via: c.via, storeFileId: c.file.storeFileId, clientSees: c.clientSees, reason: c.via === "exact" ? "in the approved copy" : "same file as one in the approved copy" }
        : { rowId: c.row.id, action: "leave", via: c.via, storeFileId: c.file.storeFileId, clientSees: c.clientSees, reason: "a second record of a file whose record already points to storage — stays on Drive" })
    })
  }
  return rows.map((r) => verdicts.get(r.id) as RowVerdict)
}

export interface GoLiveReport {
  accountId: string
  mayGoLive: boolean
  blockers: string[]
  rows: { total: number; exact: number; twin: number; catchUp: number; leftOnDrive: number; clientSeesTotal: number; clientSeesLeftOnDrive: number }
  /** records the client sees today that would NOT be in the new storage (they still open from Drive) */
  clientStillOnDrive: Array<{ rowId: string; name: string | null; reason: string }>
}

/** Pure: the dry-run report from the verdicts. */
export function buildGoLiveReport(accountId: string, blockers: string[], rows: CrmDocRow[], verdicts: RowVerdict[]): GoLiveReport {
  const nameOf = new Map(rows.map((r) => [r.id, r.file_name]))
  const cand = verdicts.filter((v) => !v.reason.startsWith("already points"))
  const left = cand.filter((v) => v.action === "leave")
  const seen = cand.filter((v) => v.clientSees)
  const seenLeft = seen.filter((v) => v.action === "leave")
  return {
    accountId,
    mayGoLive: blockers.length === 0,
    blockers,
    rows: {
      total: cand.length,
      exact: verdicts.filter((v) => v.action === "repoint" && v.via === "exact").length,
      twin: verdicts.filter((v) => v.action === "repoint" && v.via === "twin").length,
      catchUp: verdicts.filter((v) => v.action === "catchup").length,
      leftOnDrive: left.length,
      clientSeesTotal: seen.length,
      clientSeesLeftOnDrive: seenLeft.length,
    },
    clientStillOnDrive: seenLeft.map((v) => ({ rowId: v.rowId, name: nameOf.get(v.rowId) ?? null, reason: v.reason })),
  }
}

/**
 * Pure: after re-pointing, may this client-visible record stay re-pointed? (stored file typed, not closed, not someone's
 * personal file) — the same answer the portal gives. A record the client could not open from storage keeps its Drive link.
 */
export function mustStayOnDrive(p: { clientSees: boolean; closedToClients: boolean; personalOutsidePerson: boolean }): boolean {
  return p.clientSees && (p.closedToClients || p.personalOutsidePerson)
}

export { storePointer, storeDocumentLink }
