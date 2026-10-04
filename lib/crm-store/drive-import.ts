/**
 * CRM Store — "Move this company to the new storage" (master plan Stage 2 mechanics; Antonio "go" 2026-09-29).
 *
 * One RUN moves one existing company: its storage is created (5 standard folders), its real Google Drive
 * folder is walked (all levels), every file is copied into the matching store folder, and each CRM
 * `documents` row of that file is RE-POINTED IN PLACE (same row, same client visibility, same history) to
 * the store copy. A per-file ledger (store_import_items) keeps what each Drive file became, the row's OLD
 * pointer (so the move can be undone) and the parity facts (size + Drive md5 against the bytes saved).
 * CRM rows whose bytes are in Supabase Storage ("storage:" pointers) are brought over too — a Drive walk
 * never finds them. Drive itself is never changed.
 *
 * The run is done in BATCHES (continueDriveImport, ~25 files / 40 s per call) so a large company never
 * outlasts the server's time limit, and a stopped run simply continues (every save is idempotent).
 *
 * Rules:
 *   · a personal document (catalog type "personal", or a file in the Drive "2. Contacts") goes to the
 *     PERSON's own storage — their row's contact, else a sub-folder named after a member, else the only
 *     member; if nobody can be told apart it goes to "5. Correspondence" hidden, marked Needs review;
 *     the same passport in several places is kept once per person (a duplicate is recorded as "merged");
 *   · a file at the very top of the Drive folder, or in an unknown top folder, goes to "5. Correspondence"
 *     (keeping its sub-folders) — the top one marked Needs review;
 *   · type = the row's type (through the catalog's legacy id, else its name); no row / unknown = no type
 *     (hidden, "Needs a type"); tax year = the row's tax year, else the nearest year folder;
 *   · client visibility = the row's, unchanged; a file with no row is listed hidden;
 *   · Google Docs / Sheets / shortcuts are NOT moved (recorded as skipped, stay in Drive) — Antonio decides;
 *   · each imported file gets the backup's "already safe in Drive" record (so the backup never re-copies it).
 *
 * Where it may run: the store's pilot environment only (sandbox) — and, outside production, only a Drive
 * folder that sits in the TEST Shared Drive (sandbox companies are copies that point at REAL client folders).
 */
import { labelKey, queueTypeName, typeNameAnswers } from "./type-names"
import { IMPORT_ITEM_STATUSES, IMPORT_RUN_MODES } from "./vocabularies"
import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export const IMPORT_BATCH_FILES = 25
export const IMPORT_BATCH_MS = 40_000
export const IMPORT_MAX_ITEMS = 5000
export const IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024
const GOOGLE_FOLDER = "application/vnd.google-apps.folder"
const PROD_DRIVE = "0AOLZHXSfKUMHUk9PVA"
/** The company Shared Drive in production — read from the Drive module's own setting (one source). */
async function companyDrive(): Promise<string> {
  const { sharedDriveId } = await import("@/lib/google-drive")
  return sharedDriveId()
}

export type ItemStatus = (typeof IMPORT_ITEM_STATUSES)[number]
export interface ImportItem {
  id: string; run_id: string; source: "drive" | "storage"; source_id: string; drive_path: string[]; name: string
  mime_type: string | null; size_bytes: number | null; source_md5: string | null; status: ItemStatus; reason: string | null
  store_file_id: string | null; sha256: string | null; landed_in: string | null
  repointed: Array<{ id: string; drive_file_id: string; drive_link: string | null; created?: boolean }>
}
export interface RunView {
  id: string; accountId: string; ownerId: string | null; status: string; mode: ImportMode; startedAt: string; finishedAt: string | null
  counts: { total: number; pending: number; working: number; done: number; merged: number; skipped: number; failed: number }
  report: ImportReport | null
}
export interface ImportReport {
  folders: Array<{ folder: string; driveFiles: number; driveBytes: number; moved: number; movedBytes: number; merged: number; skipped: number; failed: number; checksumChecked: number }>
  rowsRepointed: number; rowsCreated: number; fromStorage: number
  skipped: Array<{ name: string; where: string; reason: string }>
  failed: Array<{ name: string; where: string; reason: string }>
  needsReview: number
  /** copied, but the client could see them and they have no type — their CRM records still open from Drive */
  waitingForType: Array<{ name: string; where: string; fileId: string | null }>
  /** a merged copy whose record the client sees, while the kept copy has its own record — checked by hand */
  secondRecords?: Array<{ name: string; where: string }>
  parityOk: boolean
  stillReadDrive: string[]
}

// ─────────────────────────────────────────────────────────────── pure helpers (unit-tested)

/** The store folder kind a top-level Drive folder maps to ("1. Company" → company …), by its leading number or name. */
export function kindForTopFolder(name: string): "company" | "contacts" | "tax" | "banking" | "correspondence" | null {
  const n = name.trim().toLowerCase()
  const m = n.match(/^([1-5])\s*[.)-]?\s*/)
  const byNumber: Record<string, "company" | "contacts" | "tax" | "banking" | "correspondence"> = { "1": "company", "2": "contacts", "3": "tax", "4": "banking", "5": "correspondence" }
  if (m) return byNumber[m[1]]
  const rest = n
  if (/^company$/.test(rest)) return "company"
  if (/^contacts?$/.test(rest)) return "contacts"
  if (/^tax(es)?$/.test(rest)) return "tax"
  if (/^bank(ing)?$/.test(rest)) return "banking"
  if (/^correspondence$/.test(rest)) return "correspondence"
  return null
}

/** Pure: whose personal document this is — the row's contact, a sub-folder named after a member, or the only member. */
export function pickPerson(p: { rowContactId: string | null; subfolder: string | null; members: Array<{ contactId: string; name: string }> }): string | null {
  const ids = new Set(p.members.map((m) => m.contactId))
  if (p.rowContactId && ids.has(p.rowContactId)) return p.rowContactId
  if (p.subfolder) {
    const key = p.subfolder.trim().toLowerCase()
    const hit = p.members.filter((m) => m.name.trim().toLowerCase() === key)
    if (hit.length === 1) return hit[0].contactId
    // a sub-folder named for someone who is NOT a member (a spouse, a partner …): never the sole member's — it goes to
    // Correspondence marked "Needs review" instead of filing another person's passport under this one (council 2026-10-02)
    if (key) return null
  }
  if (p.members.length === 1) return p.members[0].contactId
  return null
}

/**
 * Pure: why a company may NOT start an import now, in plain words (null = fine). Council 2026-10-02: a Drive folder shared with another
 * company or held by a contact would copy THAT client's files here, and a company that already has live storage would get hidden copy
 * files mixed into it.
 */
export function importStartBlocker(p: { companyName: string; otherAccountsOnSameFolder: number; contactsOnSameFolder: number; hasLiveStorage: boolean; mode: ImportMode }): string | null {
  if (p.otherAccountsOnSameFolder > 0 || p.contactsOnSameFolder > 0) {
    return `${p.companyName}'s Drive folder is also used by ${p.otherAccountsOnSameFolder + p.contactsOnSameFolder} other record(s) — copying it would bring another client's files in. Sort that out first.`
  }
  if (p.mode === "copy" && p.hasLiveStorage) {
    return `${p.companyName} already has live files in the new storage — a study copy would mix hidden copies into them. Study copies are only for companies that are not in the new storage yet.`
  }
  return null
}

/** A file stored while its CRM record keeps opening from Drive (no type yet, or not showable as it is). */
export const WAITING_RE = /\((Needs a type|Still on Drive)\)/
/** Removes that sentence from a ledger note once the record has come over. */
export const WAITING_SENTENCE_RE = /\s*The client could see (this|it) but .*?\((Needs a type|Still on Drive)\)\.?/

/** Pure: the parity report of a run from its ledger rows. Parity holds when nothing failed and nothing is pending. */
export function buildReport(items: ImportItem[], stillReadDrive: string[]): ImportReport {
  const byFolder = new Map<string, ImportReport["folders"][number]>()
  // a plan-driven build row carries its placement in drive_path (["PLAN", fingerprint, JSON]) — show where it landed instead
  const isPlan = (it: ImportItem) => it.drive_path[0] === "PLAN"
  const top = (it: ImportItem) => (it.source === "storage" ? "(files kept outside Drive)" : isPlan(it) ? "(built from the approved plan)" : it.drive_path[0] ?? "(top of the Drive folder)")
  for (const it of items) {
    const k = top(it)
    const f = byFolder.get(k) ?? { folder: k, driveFiles: 0, driveBytes: 0, moved: 0, movedBytes: 0, merged: 0, skipped: 0, failed: 0, checksumChecked: 0 }
    f.driveFiles++
    f.driveBytes += Number(it.size_bytes ?? 0)
    if (it.status === "done") { f.moved++; f.movedBytes += Number(it.size_bytes ?? 0); if (it.source_md5) f.checksumChecked++ }
    if (it.status === "merged") f.merged++
    if (it.status === "skipped") f.skipped++
    if (it.status === "failed") f.failed++
    byFolder.set(k, f)
  }
  const where = (it: ImportItem) => (it.source === "storage" ? "outside Drive" : isPlan(it) ? (it.landed_in ?? "the approved plan") : it.drive_path.join(" › ") || "top of the Drive folder")
  return {
    folders: Array.from(byFolder.values()).sort((a, b) => a.folder.localeCompare(b.folder)),
    rowsRepointed: items.reduce((n, it) => n + it.repointed.filter((r) => !r.created).length, 0),
    rowsCreated: items.reduce((n, it) => n + it.repointed.filter((r) => r.created).length, 0),
    fromStorage: items.filter((it) => it.source === "storage" && (it.status === "done" || it.status === "merged")).length,
    skipped: items.filter((it) => it.status === "skipped").map((it) => ({ name: it.name, where: where(it), reason: it.reason ?? "" })),
    failed: items.filter((it) => it.status === "failed").map((it) => ({ name: it.name, where: where(it), reason: it.reason ?? "" })),
    needsReview: items.filter((it) => /needs review/i.test(it.reason ?? "")).length,
    waitingForType: items.filter((it) => WAITING_RE.test(it.reason ?? "")).map((it) => ({ name: it.name, where: where(it), fileId: it.store_file_id })),
    secondRecords: items.filter((it) => /\(Second record\)/.test(it.reason ?? "")).map((it) => ({ name: it.name, where: where(it) })),
    parityOk: items.every((it) => it.status !== "failed" && it.status !== "pending" && it.status !== "working"),
    stillReadDrive,
  }
}

/** Pure: why a Drive item is not moved (Google-native files and shortcuts), else null. */
export function skipReasonFor(mime: string | null): string | null {
  const m = mime ?? ""
  if (!m.startsWith("application/vnd.google-apps.")) return null
  if (m === "application/vnd.google-apps.shortcut") return "A Drive shortcut — not moved (it points elsewhere)."
  return "A Google Docs/Sheets file — not moved (stays in Drive until you decide: export as PDF, or keep in Drive)."
}

/** Pure: a Drive file name the store accepts — no "/" or "\\" or control characters, at most 255 characters with
 *  its extension kept. Folder names are cleaned by the folder helpers; file names here. */
export function cleanImportName(name: string): string {
  let n = name.normalize("NFC").replace(/[\/\\]/g, "-").replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!n || n === "." || n === "..") n = "Untitled"
  if (n.length > 255) {
    const m = n.match(/(\.[A-Za-z0-9]{1,8})$/)
    const ext = m ? m[1] : ""
    n = n.slice(0, 255 - ext.length) + ext
  }
  return n
}

/** The parts of the CRM that still read files only from Drive (a moved company's files are no longer there for them). */
export const STILL_READ_DRIVE = [
  "the accountant hand-off (tax)", "the welcome package", "Generate Documents (Operating Agreement)",
  "the AI/MCP document tools", "bank-statement processing", "portal Services and service-workspace pages", "portal correspondence",
]

const md5Hex = (b: Buffer) => createHash("md5").update(b).digest("hex")
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex")

// ─────────────────────────────────────────────────────────────── gates

/** Throws unless a move may run here: the pilot environment, a live (not faked) Drive, and outside production
 *  only a folder in the TEST Shared Drive. */
export async function assertMayImportFrom(driveFolderId: string, mode: ImportMode = "move"): Promise<void> {
  const { pilotEnvironmentAllowed } = await import("./formation-pilot")
  if (!pilotEnvironmentAllowed() && !(mode === "copy" && (studyCopyAllowed() || planBuildAllowed()))) throw new Error(mode === "copy" ? "Copying clients from Google Drive is not switched on here." : "Moving a company to the new storage is not switched on here.")
  const { isProductionDatabase } = await import("@/lib/google-drive-guard")
  const { getDriveItemAnyDrive } = await import("@/lib/google-drive")
  const item = await getDriveItemAnyDrive(driveFolderId)
  if (item.mimeType !== GOOGLE_FOLDER) throw new Error("The company's Drive link is not a folder.")
  if (!isProductionDatabase()) {
    const test = (process.env.STORE_TEST_DRIVE_ID || process.env.GOOGLE_SHARED_DRIVE_ID || "").trim()
    if (!test || test === PROD_DRIVE) throw new Error("No TEST Drive is set here — a move outside production only reads the TEST Drive.")
    if (item.driveId !== test) throw new Error("This company's Drive folder is not in the TEST Drive — outside production only test folders may be moved (sandbox companies point at real client folders).")
  } else if (item.driveId !== await companyDrive()) {
    throw new Error("This company's Drive folder is not in the company Shared Drive — only client folders there can be copied.")
  }
}

export type ImportMode = (typeof IMPORT_RUN_MODES)[number]

/** A storage a study copy CREATED is "study only" (the CRM keeps using Drive for it); a real move makes it the
 *  company's / person's storage. A storage that already existed is never marked study only. */
export async function markStudy(ownerId: string, mode: ImportMode, createdNow: boolean): Promise<void> {
  if (mode === "copy" && !createdNow) return
  const { error } = await db().from("store_owners").update({ study_only: mode === "copy" }).eq("id", ownerId).eq("study_only", mode !== "copy")
  if (error) throw new Error(`The storage could not be marked (${error.message}).`)
}

/** The STUDY copy (Antonio 2026-09-29: "pick one client's Drive folder, copy it into our storage, organise it and
 *  learn the rules") — reads Drive, writes only into the new storage, never touches a client's records, so it may
 *  run in PRODUCTION for owners when STORE_STUDY_COPY=1 is set there. The real switch-over ("move") stays sandbox-only. */
export function studyCopyAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORE_STUDY_COPY === "1"
}

/** The plan-driven build (one hand-approved company at a time) has its OWN switch, default off. */
export function planBuildAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.STORE_PLAN_BUILD === "1"
}

/** Is this run a study copy? (a missing run → false) */
export async function runIsCopy(runId: string): Promise<boolean> {
  const { data } = await db().from("store_import_runs").select("mode").eq("id", runId).maybeSingle()
  return data?.mode === "copy"
}

// ─────────────────────────────────────────────────────────────── start

/** Start (or resume) the move of one company. Scans the Drive folder and the company's storage: rows into the ledger. */
export async function startDriveImport(accountId: string, actorId: string | null, opts: { mode?: ImportMode } = {}): Promise<RunView> {
  const mode: ImportMode = opts.mode ?? "move"
  const { data: acct, error: aErr } = await db().from("accounts").select("id, company_name, drive_folder_id").eq("id", accountId).maybeSingle()
  if (aErr) throw new Error(`Could not read the company (${aErr.message}).`)
  if (!acct) throw new Error("Company not found.")
  // where may this run at all (checked before anything is touched)
  const { pilotEnvironmentAllowed } = await import("./formation-pilot")
  if (!pilotEnvironmentAllowed() && !(mode === "copy" && studyCopyAllowed())) throw new Error(mode === "copy" ? "Copying clients from Google Drive is not switched on here." : "Moving a company to the new storage is not switched on here.")
  // an open run continues — never a second one
  const { data: open } = await db().from("store_import_runs").select("id, status, updated_at, mode").eq("account_id", accountId).in("status", ["scanning", "moving", "undoing"]).maybeSingle()
  if (open && (open.mode === "copy") !== (mode === "copy")) throw new Error(open.mode === "copy" ? "A study copy of this company is open — finish or remove it first." : "A move of this company is running.")
  if (open?.status === "undoing") throw new Error("This company's copy / move is being undone — try again in a minute.")
  // a scan whose request died (never reached "moving") is closed after 10 minutes and a new one starts
  if (open?.status === "scanning" && Date.now() - new Date(open.updated_at as string).getTime() > 10 * 60_000) {
    await db().from("store_import_runs").update({ status: "failed", finished_at: new Date().toISOString(), report: { error: "The scan stopped before it finished." } }).eq("id", open.id).eq("status", "scanning")
  } else if (open?.id) return runView(open.id as string)
  const { data: doneRun } = await db().from("store_import_runs").select("id, mode").eq("account_id", accountId).in("status", ["done", "incomplete"]).limit(1).maybeSingle()
  if (doneRun?.id) throw new Error(doneRun.mode === "copy"
    ? "This company was already copied into the new storage — undo that copy first to copy it again."
    : "This company has already been moved to the new storage — undo that move first to run it again.")
  if (!acct.drive_folder_id) throw new Error("This company has no Drive folder.")
  {
    const folder = acct.drive_folder_id as string
    const [{ count: otherAccounts }, { count: contactHolders }, { data: ownerRow }] = await Promise.all([
      db().from("accounts").select("id", { count: "exact", head: true }).eq("drive_folder_id", folder).neq("id", accountId),
      db().from("contacts").select("id", { count: "exact", head: true }).eq("drive_folder_id", folder),
      db().from("store_owners").select("id, study_only").eq("account_id", accountId).eq("kind", "company").maybeSingle(),
    ])
    const why = importStartBlocker({ companyName: acct.company_name as string, otherAccountsOnSameFolder: otherAccounts ?? 0, contactsOnSameFolder: contactHolders ?? 0, hasLiveStorage: !!ownerRow && ownerRow.study_only === false, mode })
    if (why) throw new Error(why)
  }
  await assertMayImportFrom(acct.drive_folder_id as string, mode)

  const { data: run, error: rErr } = await db().from("store_import_runs")
    .insert({ account_id: accountId, drive_folder_id: acct.drive_folder_id, status: "scanning", started_by: actorId, mode }).select("id").single()
  if (rErr) throw new Error(/uq_store_import_runs_open|duplicate/i.test(rErr.message) ? "A move of this company is already running." : `The move could not start (${rErr.message}).`)
  try {
    // the company's storage and its 5 standard folders (idempotent)
    const { data: had } = await db().from("store_owners").select("id").eq("account_id", accountId).eq("kind", "company").maybeSingle()
    const { data: ownerId, error: oErr } = await db().rpc("store_ensure_owner", { p_kind: "company", p_ref: accountId })
    if (oErr || !ownerId) throw new Error(`The company's storage could not be created (${oErr?.message ?? "no id"}).`)
    await markStudy(ownerId as string, mode, !had)
    const { COMPANY_TEMPLATE, storeSafeFolderName } = await import("./formation-pilot")
    const { error: tErr } = await db().rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(acct.company_name as string) })
    if (tErr) throw new Error(`The company's folders could not be created (${tErr.message}).`)
    // scan Drive (all levels) + the rows kept in Supabase Storage
    const items = await scanDrive(acct.drive_folder_id as string)
    const { data: srows, error: sErr } = await db().from("documents").select("drive_file_id, file_name, mime_type, file_size").eq("account_id", accountId).like("drive_file_id", "storage:%")
    if (sErr) throw new Error(`Could not read the company's documents (${sErr.message}).`)
    for (const r of (srows ?? []) as { drive_file_id: string; file_name: string; mime_type: string | null; file_size: number | null }[]) {
      items.push({ source: "storage", source_id: r.drive_file_id, drive_path: [], name: r.file_name, mime_type: r.mime_type, size_bytes: r.file_size, source_md5: null })
    }
    if (items.length > IMPORT_MAX_ITEMS) throw new Error(`This company has ${items.length} files — more than one move takes (${IMPORT_MAX_ITEMS}).`)
    for (let i = 0; i < items.length; i += 500) {
      const { error } = await db().from("store_import_items").upsert(items.slice(i, i + 500).map((it) => ({ ...it, run_id: run.id })), { onConflict: "run_id,source,source_id", ignoreDuplicates: true })
      if (error) throw new Error(`The file list could not be saved (${error.message}).`)
    }
    await db().from("store_import_runs").update({ owner_id: ownerId, status: "moving", updated_at: new Date().toISOString() }).eq("id", run.id)
  } catch (e) {
    await db().from("store_import_runs").update({ status: "failed", finished_at: new Date().toISOString(), report: { error: e instanceof Error ? e.message : String(e) } }).eq("id", run.id)
    throw e
  }
  return runView(run.id as string)
}

export type ScanItem = Pick<ImportItem, "source" | "source_id" | "drive_path" | "name" | "mime_type" | "size_bytes" | "source_md5">

export async function scanDrive(rootId: string): Promise<ScanItem[]> {
  const { listFolderPageAnyDrive } = await import("@/lib/google-drive")
  const out: ScanItem[] = []
  const walk = async (folderId: string, path: string[], depth: number) => {
    if (depth > 20) throw new Error(`Drive folders nested too deep at ${path.join(" › ")}.`)
    let token: string | null = null
    do {
      const page = await listFolderPageAnyDrive(folderId, token)
      for (const f of page.files) {
        if (f.mimeType === GOOGLE_FOLDER) { await walk(f.id, [...path, f.name], depth + 1); continue }
        out.push({ source: "drive", source_id: f.id, drive_path: path, name: f.name, mime_type: f.mimeType, size_bytes: f.size ? Number(f.size) : null, source_md5: f.md5Checksum ?? null })
        if (out.length > IMPORT_MAX_ITEMS) return
      }
      token = page.nextPageToken
    } while (token)
  }
  await walk(rootId, [], 0)
  return out
}

// ─────────────────────────────────────────────────────────────── continue (one batch)

interface Ctx {
  runId: string; accountId: string; companyOwner: string; actorId: string | null
  /** "copy" = a STUDY copy: files are copied and organised in the new storage, the client's CRM records stay on
   *  Drive and nothing changes for the client or any CRM feature; "move" = the real switch-over */
  mode: ImportMode
  members: Array<{ contactId: string; name: string }>
  types: Map<string, { slug: string; display: string; personal: boolean; staffOnly: boolean; draftNeverVisible: boolean; legacyId: number | null }>
  folderByKind: Map<string, string>
}

type TypeInfo = Ctx["types"] extends Map<string, infer V> ? V : never

/** The document types by slug / type number / name, plus the labels answered in the type questions. */
async function loadTypeMap(types: unknown[]): Promise<Ctx["types"]> {
  const typeMap = new Map<string, TypeInfo>()
  for (const t of types as { slug: string; display_name: string; metadata: Record<string, unknown> | null }[]) {
    const m = t.metadata ?? {}
    const v = { slug: t.slug, display: t.display_name, personal: m.personal === true, staffOnly: m.staff_only === true, draftNeverVisible: m.draft_never_visible === true, legacyId: typeof m.legacy_document_type_id === "number" ? m.legacy_document_type_id : null }
    typeMap.set(`slug:${t.slug}`, v)
    typeMap.set(`name:${labelKey(t.display_name)}`, v)
    if (v.legacyId != null) typeMap.set(`legacy:${v.legacyId}`, v)
  }
  // labels answered in the type questions ("Lease Agreement" = Office Lease …) — data, never a list in code
  for (const [label, slug] of Array.from((await typeNameAnswers()).entries())) {
    const v = typeMap.get(`slug:${slug}`)
    if (v && !typeMap.has(`name:${label}`)) typeMap.set(`name:${label}`, v)
  }
  return typeMap
}

/** Pure: a CRM record's type — by its type number first, else its label. */
export function typeOfRow(types: Map<string, { slug: string }>, row: { document_type_id: number | null; document_type_name: string | null } | null) {
  if (!row) return null
  return (row.document_type_id != null ? types.get(`legacy:${row.document_type_id}`) : undefined)
    ?? (row.document_type_name ? types.get(`name:${labelKey(row.document_type_name)}`) : undefined) ?? null
}

/** Move the next batch of files. Returns the run's state; call again while it says "moving". */
export async function continueDriveImport(runId: string, actorId: string | null, budget = { files: IMPORT_BATCH_FILES, ms: IMPORT_BATCH_MS }): Promise<RunView> {
  const t0 = Date.now()
  const { data: run, error } = await db().from("store_import_runs").select("id, account_id, owner_id, status, mode").eq("id", runId).maybeSingle()
  if (error) throw new Error(`Could not read the move (${error.message}).`)
  if (!run) throw new Error("Move not found.")
  if (run.status !== "moving") return runView(runId)
  // a plan-driven build (hand-approved placement per file) is continued by its own module
  {
    const { isPlanRun, continuePlanBuild } = await import("./plan-build")
    if (await isPlanRun(runId)) return continuePlanBuild(runId, actorId, budget)
  }
  const ctx = await loadCtx(run.id, run.account_id, run.owner_id, actorId, run.mode === "copy" ? "copy" : "move")
  // CLAIM the next files (two tabs never move the same file; a claim of a request that died is taken over)
  const { data: claimed, error: pErr } = await db().rpc("store_import_claim", { p_run_id: runId, p_limit: budget.files })
  if (pErr) throw new Error(`Could not read the files to move (${pErr.message}).`)
  const list = (claimed ?? []) as ImportItem[]
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    if (Date.now() - t0 > budget.ms) {
      // out of time: give the rest back
      await db().from("store_import_items").update({ status: "pending", updated_at: new Date().toISOString() }).in("id", list.slice(i).map((x) => x.id)).eq("status", "working")
      break
    }
    let patch: Partial<ImportItem>
    const saved: { fileId: string | null } = { fileId: null }
    try { patch = await moveOne(it, ctx, saved) } catch (e) { patch = { status: "failed", reason: e instanceof Error ? e.message : String(e), ...(saved.fileId ? { store_file_id: saved.fileId } : {}) } }
    await db().from("store_import_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", it.id).eq("status", "working")
  }
  const { count } = await db().from("store_import_items").select("id", { count: "exact", head: true }).eq("run_id", runId).in("status", ["pending", "working"])
  if ((count ?? 0) === 0) await finishRun(runId, run.owner_id, ctx.mode)
  return runView(runId)
}

async function loadCtx(runId: string, accountId: string, ownerId: string, actorId: string | null, mode: ImportMode = "move"): Promise<Ctx> {
  const [{ data: links, error: lErr }, { data: types, error: tErr }, { data: folders, error: fErr }] = await Promise.all([
    db().from("account_contacts").select("contact_id, contacts(full_name)").eq("account_id", accountId),
    db().from("catalog_entries").select("slug, display_name, metadata").eq("catalog_id", "storage_document_types"),
    db().from("store_folders").select("id, kind, parent_id").eq("owner_id", ownerId).is("trashed_at", null),
  ])
  if (lErr || tErr || fErr) throw new Error(`Could not read the company's set-up (${(lErr ?? tErr ?? fErr).message}).`)
  const members = ((links ?? []) as { contact_id: string; contacts: { full_name: string | null } | null }[])
    .map((l) => ({ contactId: l.contact_id, name: l.contacts?.full_name ?? "" }))
  const typeMap = await loadTypeMap(types ?? [])
  const folderByKind = new Map<string, string>()
  for (const f of (folders ?? []) as { id: string; kind: string; parent_id: string | null }[]) if (f.parent_id && !folderByKind.has(f.kind)) folderByKind.set(f.kind, f.id)
  return { runId, accountId, companyOwner: ownerId, actorId, mode, members, types: typeMap, folderByKind }
}

interface DocRow { id: string; drive_file_id: string; drive_link: string | null; document_type_id: number | null; document_type_name: string | null; category: number | null; contact_id: string | null; account_id: string | null; portal_visible: boolean | null; tax_year: number | null }

async function moveOne(it: ImportItem, ctx: Ctx, saved: { fileId: string | null } = { fileId: null }): Promise<Partial<ImportItem>> {
  const skip = it.source === "drive" ? skipReasonFor(it.mime_type) : null
  if (skip) return { status: "skipped", reason: skip }
  if (it.size_bytes != null && it.size_bytes > IMPORT_MAX_FILE_BYTES) return { status: "failed", reason: `Too large for the new storage (${Math.round(it.size_bytes / 1048576)} MB, limit ${IMPORT_MAX_FILE_BYTES / 1048576} MB).` }

  // the CRM rows of this file (this company's, or a member's personal row) — plus, when a request died after
  // re-pointing, the rows this item already recorded (they now point at the store and would not be found again)
  const memberIds = ctx.members.map((m) => m.contactId)
  const { data: rowsRaw, error: rErr } = await db().from("documents")
    .select("id, drive_file_id, drive_link, document_type_id, document_type_name, category, contact_id, account_id, portal_visible, tax_year").eq("drive_file_id", it.source_id)
  if (rErr) throw new Error(`Could not read the CRM record (${rErr.message}).`)
  const found = ((rowsRaw ?? []) as DocRow[]).filter((r) => r.account_id === ctx.accountId || (!r.account_id && r.contact_id && memberIds.includes(r.contact_id)))
  const earlier = (it.repointed ?? []).filter((r) => !r.created)
  let already: DocRow[] = []
  if (earlier.length) {
    const { data: ar, error: aErr } = await db().from("documents")
      .select("id, drive_file_id, drive_link, document_type_id, document_type_name, category, contact_id, account_id, portal_visible, tax_year").in("id", earlier.map((r) => r.id))
    if (aErr) throw new Error(`Could not read the CRM record (${aErr.message}).`)
    already = (ar ?? []) as DocRow[]
  }
  const rows = [...already, ...found.filter((r) => !already.some((a) => a.id === r.id))]

  // the bytes, checked against what the source says
  let bytes: Buffer
  if (it.source === "drive") {
    const { downloadBinaryAnyDrive } = await import("@/lib/google-drive")
    bytes = await downloadBinaryAnyDrive(it.source_id)
  } else {
    const rest = it.source_id.slice("storage:".length)
    const slash = rest.indexOf("/")
    if (slash <= 0) return { status: "failed", reason: "An unreadable storage location." }
    const { data, error } = await supabaseAdmin.storage.from(rest.slice(0, slash)).download(rest.slice(slash + 1))
    if (error || !data) return { status: "failed", reason: `Could not be read from storage (${error?.message ?? "no data"}).` }
    bytes = Buffer.from(await data.arrayBuffer())
  }
  if (bytes.length > IMPORT_MAX_FILE_BYTES) return { status: "failed", reason: `Too large for the new storage (${Math.round(bytes.length / 1048576)} MB).` }
  if (it.size_bytes != null && bytes.length !== Number(it.size_bytes)) return { status: "failed", reason: `Came back ${bytes.length} bytes, the record says ${it.size_bytes} — not moved.` }
  if (it.source_md5 && md5Hex(bytes) !== it.source_md5) return { status: "failed", reason: "The content does not match Drive's fingerprint — not moved." }
  const sha = sha256Hex(bytes)

  // type, visibility, year — from the ONE row that will follow the store (a second row of the same file stays on Drive)
  const row0 = rows[0] ?? null
  const type = typeOfRow(ctx.types, row0) as TypeInfo | null
  // a label the types don't know, used by several records → one question for staff (never fails the move)
  if (!type && row0?.document_type_name) {
    await queueTypeName(row0.document_type_name, { from: "drive-import", run: ctx.runId }).catch((e) => console.error(`[crm-store] could not ask about "${row0.document_type_name}": ${e instanceof Error ? e.message : e}`))
  }
  const visible = row0?.portal_visible === true

  // where it lands
  const top = it.source === "drive" ? it.drive_path[0] ?? null : null
  const topKind = it.source === "drive" ? (top ? kindForTopFolder(top) : null) : kindForCategory(row0?.category ?? null)
  const personalish = type?.personal === true || topKind === "contacts" || (it.source === "storage" && row0?.category === 2)
  let ownerId = ctx.companyOwner
  let folderId: string
  let needsReview: string | null = null
  let subPath = it.source === "drive" ? it.drive_path.slice(1) : []
  let docType = type?.slug ?? null
  if (personalish) {
    const person = pickPerson({ rowContactId: row0?.contact_id ?? null, subfolder: topKind === "contacts" ? it.drive_path[1] ?? null : null, members: ctx.members })
      // an identical file elsewhere in this company whose CRM record names the member (a copy of the same passport)
      ?? (it.source_md5 ? await personBySameContent(ctx, it) : null)
    if (person) {
      const { ensurePersonOwner, folderOfKind } = await import("./formation-pilot")
      const name = ctx.members.find((m) => m.contactId === person)?.name || "Person"
      const { data: had } = await db().from("store_owners").select("id").eq("contact_id", person).eq("kind", "person").maybeSingle()
      ownerId = await ensurePersonOwner(person, name)
      await markStudy(ownerId, ctx.mode, !had)
      folderId = await folderOfKind(ownerId, "personal")
      subPath = [] // a person's own documents sit in "Personal documents"
      // the same document already in this person's storage → kept once (never this item's own earlier copy)
      const dup = await sameContentFile(ownerId, sha, callerKeyOf(ctx, it))
      if (dup) return await mergeInto(it, dup, rows, ctx, type?.slug ?? null)
    } else {
      folderId = mustFolder(ctx, "correspondence")
      needsReview = "Found in 2. Contacts — whose document is it? (Needs review)"
      subPath = []
      if (type?.personal) docType = null // a personal type can never sit in a company folder
    }
  } else if (topKind) {
    folderId = mustFolder(ctx, topKind)
  } else {
    folderId = mustFolder(ctx, "correspondence")
    if (it.source === "drive" && !top) needsReview = "Was at the top of the company's Drive folder (Needs review)"
    else if (top) subPath = it.drive_path // an unknown top folder is kept, inside 5. Correspondence
  }
  if (subPath.length) {
    const { ensureFolderPath } = await import("./extras")
    folderId = (await ensureFolderPath(folderId, subPath, ctx.actorId)).id
  }

  const callerKey = callerKeyOf(ctx, it)
  const name = await freeName(folderId, cleanImportName(it.name), callerKey)
  const { nearestYear } = await import("./structure")
  const year = row0?.tax_year ?? (await nearestYear(folderId))
  const { saveBytesToStore } = await import("./writer")
  const w = await saveBytesToStore({
    ownerId, folderId, name, mimeType: it.mime_type, bytes, callerKey, contentChanged: true,
    documentType: docType, published: false, actor: ctx.actorId,
    ...(year ? { periodYear: year } : {}),
    ...(type?.draftNeverVisible ? { filingStatus: (visible ? "filed" : "draft") as "filed" | "draft" } : {}),
  })
  if (w.status !== "created" && w.status !== "versioned" && w.status !== "unchanged") return { status: "failed", reason: `The new storage refused it (${w.status}).` }
  saved.fileId = w.fileId
  // two batches may save the same personal document at the same moment: the EARLIEST copy is kept, a later one
  // steps back (goes to the trash) and becomes a "kept once" duplicate — both batches reach the same answer
  if (ownerId !== ctx.companyOwner) {
    const keep = await earliestSameContent(ownerId, sha)
    if (keep && keep !== w.fileId) {
      if (!ctx.actorId) throw new Error("A duplicate could not be folded without a signed-in staff member.")
      const { deleteStoreFile } = await import("./file-actions")
      await deleteStoreFile(w.fileId, ctx.actorId)
      return await mergeInto(it, keep, rows, ctx, docType)
    }
  }
  if (needsReview) {
    const { markNeedsReview } = await import("./structure")
    await markNeedsReview(w.fileId, needsReview, ctx.actorId)
  }
  let note: string | null = needsReview
  // a file the client could see but that has NO type: the portal never serves an untyped stored file, so its
  // CRM record keeps opening from Drive (the client sees exactly what they saw) until staff give it a type
  // the same for a file the client sees that the new storage may not show as it is (Needs review, a staff-only
  // type) or refuses to show: nothing changes for the client behind anyone's back — it is listed for staff
  if (ctx.mode === "copy") {
    // a STUDY copy: stored hidden, the client's records stay exactly as they are (on Drive)
    if (it.source === "drive") {
      const { error } = await db().rpc("store_import_record_ref", { p_file_id: w.fileId, p_drive_file_id: it.source_id, p_sha256: sha, p_drive_path: { area: "import", path: it.drive_path } })
      if (error) note = `${note ? `${note} ` : ""}The backup could not record the Drive original (${error.message}).`
    }
    return { status: "done", store_file_id: w.fileId, sha256: sha, landed_in: await pathOf(folderId, ownerId), repointed: [], reason: note }
  }
  let keepOnDrive = visible && !docType
  if (keepOnDrive) {
    note = `${note ? `${note} ` : ""}The client could see this but it has no type — its CRM record still opens from Drive until it gets one (Needs a type).`
  } else if (visible && (needsReview || type?.staffOnly)) {
    keepOnDrive = true
    note = `${note ? `${note} ` : ""}The client could see this but the new storage cannot show it as it is (${needsReview ? "needs review" : "a staff-only type"}) — its CRM record still opens from Drive; check it (Still on Drive).`
  } else if (visible) {
    // the client sees exactly what they saw before
    const { error } = await db().rpc("store_set_published", { p_file_id: w.fileId, p_published: true, p_actor: ctx.actorId })
    if (error) {
      keepOnDrive = true
      note = `${note ? `${note} ` : ""}The client could see this but the new storage refused to show it (${error.message.replace(/^store: /, "")}) — its CRM record still opens from Drive; check it (Still on Drive).`
    }
  }
  const repointed = keepOnDrive ? [] : await repointRows(rows, w.fileId, ownerId, folderId, it, ctx, visible)
  if (it.source === "drive") {
    const { error } = await db().rpc("store_import_record_ref", { p_file_id: w.fileId, p_drive_file_id: it.source_id, p_sha256: sha, p_drive_path: { area: "import", path: it.drive_path } })
    if (error) note = `${note ? `${note} ` : ""}The backup could not record the Drive original (${error.message}).`
  }
  return { status: "done", store_file_id: w.fileId, sha256: sha, landed_in: await pathOf(folderId, ownerId), repointed, reason: note }
}

/** A member named for an IDENTICAL file (same md5) in this same move — by its CRM record (still on Drive, or
 *  already re-pointed: the ledger keeps the row ids) or by the person storage it already landed in — else null.
 *  Works whichever of the twins is moved first. */
async function personBySameContent(ctx: Ctx, it: ImportItem): Promise<string | null> {
  const { data, error } = await db().from("store_import_items").select("source_id, store_file_id, repointed").eq("run_id", ctx.runId).eq("source", "drive").eq("source_md5", it.source_md5).neq("id", it.id)
  if (error || !data?.length) return null
  const twins = data as { source_id: string; store_file_id: string | null; repointed: ImportItem["repointed"] | null }[]
  const contacts: string[] = []
  const { data: onDrive } = await db().from("documents").select("contact_id").in("drive_file_id", twins.map((x) => x.source_id)).not("contact_id", "is", null)
  contacts.push(...((onDrive ?? []) as { contact_id: string }[]).map((r) => r.contact_id))
  const rowIds = twins.flatMap((x) => (x.repointed ?? []).filter((r) => !r.created).map((r) => r.id))
  if (rowIds.length) {
    const { data: moved } = await db().from("documents").select("contact_id").in("id", rowIds).not("contact_id", "is", null)
    contacts.push(...((moved ?? []) as { contact_id: string }[]).map((r) => r.contact_id))
  }
  const fileIds = twins.map((x) => x.store_file_id).filter((x): x is string => !!x)
  if (fileIds.length) {
    const { data: landed } = await db().from("store_files").select("store_owners(kind, contact_id)").in("id", fileIds)
    for (const f of (landed ?? []) as { store_owners: { kind: string; contact_id: string | null } | null }[]) if (f.store_owners?.kind === "person" && f.store_owners.contact_id) contacts.push(f.store_owners.contact_id)
  }
  const members = new Set(ctx.members.map((m) => m.contactId))
  const found = Array.from(new Set(contacts.filter((c) => members.has(c))))
  return found.length === 1 ? found[0] : null
}

function kindForCategory(c: number | null): "company" | "contacts" | "tax" | "banking" | "correspondence" {
  return c === 1 ? "company" : c === 2 ? "contacts" : c === 3 ? "tax" : c === 4 ? "banking" : "correspondence"
}

function mustFolder(ctx: Ctx, kind: string): string {
  const id = ctx.folderByKind.get(kind)
  if (!id) throw new Error(`The company's "${kind}" folder is missing in the new storage.`)
  return id
}

/** One key per move and file: after an undo the move can run again (the undone copies wait in the trash). */
function callerKeyOf(ctx: Ctx, it: ImportItem): string {
  return `drive-import:${ctx.runId}:${it.source}:${it.source_id}`
}

/** A live file in this storage with exactly these bytes that is NOT this item's own copy (a retry), else null. */
async function sameContentFile(ownerId: string, sha: string, ownKey: string): Promise<string | null> {
  const { data, error } = await db().from("store_files").select("id, caller_key, created_at, store_file_versions!store_files_current_version_fk!inner(sha256)")
    .eq("owner_id", ownerId).eq("state", "live").eq("store_file_versions.sha256", sha).order("created_at", { ascending: true }).order("id", { ascending: true })
  if (error) throw new Error(`Could not check for an identical file (${error.message}).`)
  const hit = ((data ?? []) as { id: string; caller_key: string | null }[]).find((f) => f.caller_key !== ownKey)
  return hit?.id ?? null
}

/** The earliest-saved live file in this storage whose current bytes are exactly these (the one that is kept). */
async function earliestSameContent(ownerId: string, sha: string): Promise<string | null> {
  const { data, error } = await db().from("store_files").select("id, created_at, store_file_versions!store_files_current_version_fk!inner(sha256)")
    .eq("owner_id", ownerId).eq("state", "live").eq("store_file_versions.sha256", sha).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(1)
  if (error) throw new Error(`Could not check for an identical file (${error.message}).`)
  return ((data ?? [])[0]?.id as string | undefined) ?? null
}

async function mergeInto(it: ImportItem, fileId: string, rows: DocRow[], ctx: Ctx, incomingType: string | null): Promise<Partial<ImportItem>> {
  // its rows follow the kept copy when that copy has no row yet (one row per stored file); else they stay on Drive
  const { storePointer } = await import("./document-pointer")
  const { data: taken } = await db().from("documents").select("id").eq("drive_file_id", storePointer(fileId)).limit(1)
  let repointed: ImportItem["repointed"] = []
  let reason = "The same document is already in this person's storage — kept once."
  const live = ctx.mode === "copy" ? [] : rows.filter((r) => !r.drive_file_id.startsWith("store:")) // a study copy never touches records
  // the kept copy has no type but this record says what it is → the kept copy takes the type (the portal never
  // serves an untyped stored file); neither has one and the client could see it → the record stays on Drive
  const { data: kept } = await db().from("store_files").select("document_type").eq("id", fileId).maybeSingle()
  let keptType = (kept?.document_type as string | null | undefined) ?? null
  if (!keptType && incomingType) {
    const { error: tErr } = await db().from("store_files").update({ document_type: incomingType }).eq("id", fileId).is("document_type", null)
    if (!tErr) keptType = incomingType
  }
  if (live.length && !keptType && live.some((r) => r.portal_visible === true)) {
    const { data: f } = await db().from("store_files").select("owner_id, folder_id").eq("id", fileId).maybeSingle()
    return { status: "merged", store_file_id: fileId, reason: `${reason} The client could see it but it has no type — its CRM record still opens from Drive until it gets one (Needs a type).`, repointed: [], landed_in: f ? await pathOf(f.folder_id, f.owner_id) : null }
  }
  if (live.length) {
    // the kept file only has the placeholder row THIS move listed (its first copy had no CRM record): the real
    // record takes its place — the placeholder goes, the real one follows the store with its own visibility
    const placeholder = taken?.length ? await placeholderOf(ctx.runId, taken[0].id as string) : null
    const vis = live.some((r) => r.portal_visible === true)
    // the client sees it: the kept copy must be shown FIRST — if the new storage can't (a draft, staff-only,
    // needs review …) the record keeps opening from Drive and is listed for staff (never a visible record on a
    // file the storage keeps hidden)
    if (vis && (!taken?.length || placeholder)) {
      const { error } = await db().rpc("store_set_published", { p_file_id: fileId, p_published: true, p_actor: ctx.actorId })
      if (error) {
        const { data: f } = await db().from("store_files").select("owner_id, folder_id").eq("id", fileId).maybeSingle()
        return { status: "merged", store_file_id: fileId, reason: `${reason} The client could see it but the new storage refused to show the kept copy — ${error.message.replace(/^store: /, "")} — its CRM record still opens from Drive; check it (Still on Drive).`, repointed: [], landed_in: f ? await pathOf(f.folder_id, f.owner_id) : null }
      }
    }
    if (placeholder) {
      const { error } = await db().from("documents").delete().eq("id", placeholder.rowId).eq("drive_file_id", storePointer(fileId))
      if (error) throw new Error(`The listed copy could not be replaced by the CRM record (${error.message}).`)
      await db().from("store_import_items").update({ repointed: placeholder.rest, updated_at: new Date().toISOString() }).eq("id", placeholder.itemId)
    }
    if (!taken?.length || placeholder) {
      repointed = await repointRows(live, fileId, null, null, it, ctx, vis)
    } else {
      reason += vis
        ? " The client sees this record too, but the kept copy already has its own CRM record — two records for one document: check them by hand (Second record)."
        : " Its CRM record still points to Drive."
    }
  }
  const { data: f } = await db().from("store_files").select("owner_id, folder_id").eq("id", fileId).maybeSingle()
  return { status: "merged", store_file_id: fileId, reason, repointed, landed_in: f ? await pathOf(f.folder_id, f.owner_id) : null }
}

/** The ledger item whose move LISTED this row as a placeholder (created), with the rest of its re-pointed list. */
async function placeholderOf(runId: string, rowId: string): Promise<{ itemId: string; rowId: string; rest: ImportItem["repointed"] } | null> {
  const { data } = await db().from("store_import_items").select("id, repointed").eq("run_id", runId).filter("repointed", "cs", JSON.stringify([{ id: rowId, created: true }])).limit(1)
  const hit = (data ?? [])[0] as { id: string; repointed: ImportItem["repointed"] } | undefined
  return hit ? { itemId: hit.id, rowId, rest: hit.repointed.filter((r) => r.id !== rowId) } : null
}

async function freeName(folderId: string, name: string, callerKey: string): Promise<string> {
  const { data, error } = await db().from("store_files").select("name, caller_key").eq("folder_id", folderId).eq("state", "live")
  if (error) throw new Error(`Could not read the folder (${error.message}).`)
  const files = (data ?? []) as { name: string; caller_key: string | null }[]
  if (files.some((f) => f.caller_key === callerKey)) return files.find((f) => f.caller_key === callerKey)!.name // a re-run: same file
  const { storeNameKey } = await import("./rules")
  if (!files.some((f) => storeNameKey(f.name) === storeNameKey(name))) return name
  const { keepBothName } = await import("./names")
  return keepBothName(name, files.map((f) => f.name))
}

/** Re-point this file's CRM row in place; no row → one hidden row is listed. The OLD pointer is written to the
 *  ledger BEFORE the row changes, so a request that dies half-way never loses what undo needs; rows an earlier
 *  (interrupted) attempt already re-pointed are kept in the list. One row per stored file. */
async function repointRows(rows: DocRow[], fileId: string, ownerId: string | null, folderId: string | null, it: ImportItem, ctx: Ctx, visible: boolean): Promise<ImportItem["repointed"]> {
  const { storePointer, storeDocumentLink } = await import("./document-pointer")
  const pointer = storePointer(fileId)
  const earlier = it.repointed ?? []
  const out: ImportItem["repointed"] = [...earlier]
  const target = earlier.some((r) => !r.created) ? null : rows.find((r) => !r.drive_file_id.startsWith("store:")) ?? null
  if (target) {
    const planned = [...out, { id: target.id, drive_file_id: target.drive_file_id, drive_link: target.drive_link }]
    const { error: lErr } = await db().from("store_import_items").update({ repointed: planned, store_file_id: fileId, updated_at: new Date().toISOString() }).eq("id", it.id)
    if (lErr) throw new Error(`The move could not record the CRM record's old link (${lErr.message}) — nothing was changed.`)
    const { error } = await db().from("documents").update({ drive_file_id: pointer, drive_link: storeDocumentLink(target.id), updated_at: new Date().toISOString() }).eq("id", target.id).eq("drive_file_id", target.drive_file_id)
    if (error) throw new Error(`The CRM record could not be re-pointed (${error.message}).`)
    out.push(planned[planned.length - 1])
  }
  if (!rows.length && !earlier.length && ownerId && folderId) {
    const { upsertStoreDocumentRow } = await import("./formation-pilot")
    const { categoryForFolder } = await import("./structure")
    const cat = await categoryForFolder(folderId)
    const { data: o } = await db().from("store_owners").select("kind, contact_id").eq("id", ownerId).maybeSingle()
    const r = await upsertStoreDocumentRow(fileId, {
      file_name: it.name, mime_type: it.mime_type, file_size: it.size_bytes, category: cat.num, category_name: cat.name,
      account_id: ctx.accountId, contact_id: o?.kind === "person" ? o.contact_id : null, portal_visible: visible, status: "classified",
    })
    if (r.inserted) out.push({ id: r.id, drive_file_id: pointer, drive_link: null, created: true })
  }
  return out
}

export async function pathOf(folderId: string, ownerId: string): Promise<string> {
  const { data } = await db().from("store_folders").select("id, name, parent_id").eq("owner_id", ownerId)
  const { pathOf: p } = await import("./extras")
  return p(folderId, new Map(((data ?? []) as { id: string; name: string; parent_id: string | null }[]).map((f) => [f.id, f])))
}

export async function finishRun(runId: string, ownerId: string, mode: ImportMode = "move"): Promise<void> {
  const { data } = await db().from("store_import_items").select("*").eq("run_id", runId)
  const report = buildReport((data ?? []) as ImportItem[], STILL_READ_DRIVE)
  const status = report.parityOk ? "done" : "incomplete"
  const { data: ended } = await db().from("store_import_runs").update({ status, report, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", runId).eq("status", "moving").select("id")
  // the 6-month backup window starts the day a company is switched (only when everything came over, and only
  // by the request that actually closed the move — never after an undo took over)
  if (mode === "move" && report.parityOk && (ended ?? []).length) await db().rpc("store_backup_mark_switched", { p_owner_id: ownerId })
}

// ─────────────────────────────────────────────────────────────── view + undo

/** Rebuild a finished move's report from its ledger (after Set type / Re-check changed what it lists). */
export async function refreshRunReport(runId: string): Promise<void> {
  const { data: run, error } = await db().from("store_import_runs").select("status").eq("id", runId).maybeSingle()
  if (error) throw new Error(`Could not read the move (${error.message}).`)
  if (!run || !["done", "incomplete"].includes(run.status)) return
  const { data: items, error: iErr } = await db().from("store_import_items").select("*").eq("run_id", runId)
  if (iErr) throw new Error(`Could not read the move's files (${iErr.message}).`)
  const report = buildReport((items ?? []) as ImportItem[], STILL_READ_DRIVE)
  const { error: uErr } = await db().from("store_import_runs").update({ report, updated_at: new Date().toISOString() }).eq("id", runId).in("status", ["done", "incomplete"])
  if (uErr) throw new Error(`Could not update the move's report (${uErr.message}).`)
}

export async function runView(runId: string): Promise<RunView> {
  const { data: run, error } = await db().from("store_import_runs").select("*").eq("id", runId).maybeSingle()
  if (error) throw new Error(`Could not read the move (${error.message}).`)
  if (!run) throw new Error("Move not found.")
  const { data: items } = await db().from("store_import_items").select("status").eq("run_id", runId)
  const counts = { total: 0, pending: 0, working: 0, done: 0, merged: 0, skipped: 0, failed: 0 }
  for (const it of (items ?? []) as { status: ItemStatus }[]) { counts.total++; counts[it.status]++ }
  const rep = run.report && typeof run.report === "object" && "folders" in run.report ? run.report as ImportReport : null
  return { id: run.id, accountId: run.account_id, ownerId: run.owner_id, status: run.status, mode: run.mode === "copy" ? "copy" : "move", startedAt: run.started_at, finishedAt: run.finished_at, counts, report: rep }
}

/** The latest move of a company (for its page), or null. */
export async function latestRunFor(accountId: string, mode?: ImportMode): Promise<RunView | null> {
  let q = db().from("store_import_runs").select("id").eq("account_id", accountId)
  if (mode) q = q.eq("mode", mode)
  const { data } = await q.order("started_at", { ascending: false }).limit(1).maybeSingle()
  return data?.id ? runView(data.id as string) : null
}

/** When this company was moved to the new storage (its latest move that was not undone), else null. */
export async function movedAt(accountId: string): Promise<{ status: string; finishedAt: string | null; startedAt: string } | null> {
  const { data, error } = await db().from("store_import_runs").select("status, finished_at, started_at").eq("account_id", accountId).eq("mode", "move")
    .in("status", ["moving", "done", "incomplete", "undoing"]).order("started_at", { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return null
  return { status: data.status, finishedAt: data.finished_at, startedAt: data.started_at }
}

/** Undo a move: every re-pointed CRM record gets its Drive pointer back, rows the move listed are removed, the
 *  moved files go to the trash, the backup's import records are dropped. Drive was never changed. Refused while a
 *  batch is still moving a file. A file is NOT trashed when its record could not be restored, when staff changed
 *  it after the move, or when another move (another company of the same person) relies on it — each is reported. */
export async function undoDriveImport(runId: string, actorId: string | null, budgetMs = 240_000): Promise<RunView> {
  const t0 = Date.now()
  if (!actorId) throw new Error("Only a signed-in staff member can undo a move.")
  const { data: run, error } = await db().from("store_import_runs").select("id, status, owner_id, report").eq("id", runId).maybeSingle()
  if (error) throw new Error(`Could not read the move (${error.message}).`)
  if (!run) throw new Error("Move not found.")
  if (run.status === "rolled_back") return runView(runId)
  const earlier = run.status === "undoing" && Array.isArray((run.report as { problems?: unknown })?.problems) ? (run.report as { problems: string[] }).problems : []
  if (run.status === "scanning") throw new Error("Wait for the scan to finish, then undo.")
  // stop new batches FIRST, then wait for none to be mid-file
  const { data: took, error: uErr } = await db().from("store_import_runs").update({ status: "undoing", updated_at: new Date().toISOString() }).eq("id", runId).in("status", ["moving", "done", "incomplete", "failed", "undoing"]).select("id")
  if (uErr) throw new Error(`The move could not be undone (${uErr.message}).`)
  if (!(took ?? []).length) return runView(runId)
  const { count: busy } = await db().from("store_import_items").select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", "working").gt("updated_at", new Date(Date.now() - 5 * 60_000).toISOString())
  if ((busy ?? 0) > 0) throw new Error("A batch is still moving files — try Undo again in a minute.")
  const { data: itemsRaw, error: iErr } = await db().from("store_import_items").select("*").eq("run_id", runId)
  if (iErr) throw new Error(`Could not read the move's files (${iErr.message}).`)
  const items = (itemsRaw ?? []) as ImportItem[]
  const problems: string[] = [...earlier]
  const unrestored = new Set<string>() // store files whose record could not be put back
  for (const it of items) {
    for (const r of it.repointed ?? []) {
      const { error: e } = r.created
        ? await db().from("documents").delete().eq("id", r.id).eq("drive_file_id", r.drive_file_id)
        // what the record said before Set type changed it (type, category, company / person) comes back too
        : await db().from("documents").update({ ...((r as { before?: Record<string, unknown> }).before ?? {}), drive_file_id: r.drive_file_id, drive_link: r.drive_link, updated_at: new Date().toISOString() }).eq("id", r.id).like("drive_file_id", "store:%")
      if (e) { problems.push(`${it.name}: its CRM record could not be put back (${e.message})`); if (it.store_file_id) unrestored.add(it.store_file_id) }
    }
  }
  const { deleteStoreFile } = await import("./file-actions")
  // merged items too: a person's file another move KEPT for both goes once the last move using it is undone
  const fileIds = Array.from(new Set(items.filter((it) => (it.status === "done" || it.status === "working" || it.status === "failed" || it.status === "merged") && it.store_file_id).map((it) => it.store_file_id as string)))
  const shaOf = new Map(items.filter((it) => it.store_file_id && it.sha256).map((it) => [it.store_file_id as string, it.sha256 as string]))
  for (const id of fileIds) {
    // a big company: the undo continues in the next request (everything here is safe to run again)
    if (Date.now() - t0 > budgetMs) {
      await db().from("store_import_runs").update({ updated_at: new Date().toISOString(), report: { undone: false, problems: Array.from(new Set(problems)) } }).eq("id", runId).eq("status", "undoing")
      return runView(runId)
    }
    const name = items.find((it) => it.store_file_id === id)?.name ?? "a file"
    if (unrestored.has(id)) { problems.push(`${name}: kept in the new storage (its CRM record still points there)`); continue }
    const { data: f } = await db().from("store_files").select("state, caller_key, store_file_versions!store_files_current_version_fk(sha256, version_no)").eq("id", id).maybeSingle()
    if (!f || f.state !== "live") {
      // already in the trash (an undo that stopped half-way and runs again): its import record goes too
      await db().from("store_external_refs").delete().eq("object_kind", "file").eq("object_id", id).eq("direction", "import")
      continue
    }
    const cur = f.store_file_versions as { sha256: string; version_no: number } | null
    if (cur && (cur.version_no > 1 || (shaOf.get(id) && cur.sha256 !== shaOf.get(id)))) { problems.push(`${name}: changed since the move — kept`); continue }
    // only a file an import CREATED (this one, or one already undone) is ever trashed — a person's real file a copy
    // merely kept once (a passport saved before, maybe shown to the client) is never touched
    const key = (f.caller_key as string | null) ?? ""
    const m = key.match(/^drive-import:([0-9a-f-]{36}):/)
    if (!m) { problems.push(`${name}: kept — it was in the new storage before this move/copy`); continue }
    if (m[1] !== runId) {
      const { data: creator } = await db().from("store_import_runs").select("status").eq("id", m[1]).maybeSingle()
      if (creator?.status !== "rolled_back") { problems.push(`${name}: kept — another company's move or copy created it`); continue }
    }
    // and never while a CRM record still points at it (the records this undo put back no longer do)
    const { count: listed, error: lErr } = await db().from("documents").select("id", { count: "exact", head: true }).eq("drive_file_id", `store:${id}`)
    if (lErr) { problems.push(`${name}: kept — could not check its CRM record (${lErr.message})`); continue }
    if ((listed ?? 0) > 0) {
      const createdByThis = items.some((it) => it.store_file_id === id && (it.repointed ?? []).some((r) => r.created))
      if (!createdByThis) { problems.push(`${name}: kept — a CRM record uses it`); continue }
    }
    const { count: others } = await db().from("store_import_items").select("id, store_import_runs!inner(status)", { count: "exact", head: true })
      .eq("store_file_id", id).neq("run_id", runId).in("status", ["done", "merged"]).neq("store_import_runs.status", "rolled_back")
    if ((others ?? 0) > 0) { problems.push(`${name}: another company's move or copy also uses it — kept`); continue }
    try { await deleteStoreFile(id, actorId) } catch (e) { problems.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); continue }
    await db().from("store_external_refs").delete().eq("object_kind", "file").eq("object_id", id).eq("direction", "import")
  }
  if (run.owner_id) await db().from("store_backup_state").update({ switched_at: null, updated_at: new Date().toISOString() }).eq("owner_id", run.owner_id)
  await db().from("store_import_runs").update({ status: "rolled_back", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { undone: true, problems: Array.from(new Set(problems)) } }).eq("id", runId)
  return runView(runId)
}

/**
 * "Re-check types" (move report): files this move stored WITHOUT a type are looked at again against the current
 * types and the answered labels. A file whose record's label now means a type gets it through Set type — the same
 * rules as by hand (a question it needs — whose passport? — leaves it listed for staff).
 */
export async function recheckRunTypes(runId: string, actorId: string | null): Promise<{ typed: number; needAnswer: number; stillUnknown: number; failed: number }> {
  const { data: run, error: rErr } = await db().from("store_import_runs").select("id, status, account_id").eq("id", runId).maybeSingle()
  if (rErr) throw new Error(`Could not read the move (${rErr.message}).`)
  if (!run || !["done", "incomplete"].includes(run.status)) throw new Error("Re-check works on a finished move.")
  const { data: links, error: lErr } = await db().from("account_contacts").select("contact_id").eq("account_id", run.account_id)
  if (lErr) throw new Error(`Could not read the company's people (${lErr.message}).`)
  const memberIds = ((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id)
  const { data: types, error: tErr } = await db().from("catalog_entries").select("slug, display_name, metadata").eq("catalog_id", "storage_document_types").eq("status", "active")
  if (tErr) throw new Error(`Could not read the document types (${tErr.message}).`)
  const map = await loadTypeMap(types ?? [])
  const { data: items, error: iErr } = await db().from("store_import_items").select("source_id, store_file_id").eq("run_id", runId).in("status", ["done", "merged"]).not("store_file_id", "is", null)
  if (iErr) throw new Error(`Could not read the move's ledger (${iErr.message}).`)
  const fileIds = Array.from(new Set(((items ?? []) as { store_file_id: string }[]).map((i) => i.store_file_id)))
  let typed = 0, needAnswer = 0, stillUnknown = 0, failed = 0
  const { storePointer } = await import("./document-pointer")
  const { setStoreFileType, SetTypeQuestionError } = await import("./set-type")
  for (const fileId of fileIds) {
    const { data: f } = await db().from("store_files").select("document_type, state").eq("id", fileId).maybeSingle()
    if (!f || f.state !== "live" || f.document_type) continue
    // stop at once if an Undo started
    const { data: now } = await db().from("store_import_runs").select("status").eq("id", runId).maybeSingle()
    if (!now || !["done", "incomplete"].includes(now.status)) throw new Error("The move is being undone — Re-check stopped.")
    const sources = ((items ?? []) as { source_id: string; store_file_id: string }[]).filter((i) => i.store_file_id === fileId).map((i) => i.source_id)
    const { data: rows, error: rowsErr } = await db().from("documents").select("document_type_id, document_type_name, account_id, contact_id").in("drive_file_id", [storePointer(fileId), ...sources])
    if (rowsErr) throw new Error(`Could not read the CRM records (${rowsErr.message}).`)
    // this company's records only (the same filter the move uses)
    const mine = ((rows ?? []) as { document_type_id: number | null; document_type_name: string | null; account_id: string | null; contact_id: string | null }[])
      .filter((r) => r.account_id === run.account_id || (!r.account_id && r.contact_id && memberIds.includes(r.contact_id)))
    const hit = mine.map((r) => typeOfRow(map, r)).find(Boolean)
    if (!hit) { stillUnknown++; continue }
    try {
      await setStoreFileType({ fileId, typeSlug: hit.slug, actorId, skipReportRefresh: true })
      typed++
    } catch (e) {
      if (e instanceof SetTypeQuestionError) { needAnswer++; continue }
      if (e instanceof Error && /being undone/.test(e.message)) throw e
      failed++ // one file that can't be typed never stops the others (Set type on it shows why)
      console.error(`[crm-store] re-check: ${fileId}: ${e instanceof Error ? e.message : e}`)
    }
  }
  await refreshRunReport(runId)
  return { typed, needAnswer, stillUnknown, failed }
}

// ─────────────────────────────────────────────────────────────── the Drive folder picker (study copy)

export interface DriveFolderRow {
  id: string; name: string
  company: { accountId: string; name: string; status: string | null } | null
  copy: { runId: string; status: string; mode: ImportMode; ownerId: string | null; files: number } | null
}

/** Match Drive folders to the CRM companies that use them, and to their copies / moves. */
async function attachCompanies(rows: DriveFolderRow[]): Promise<void> {
  if (!rows.length) return
  // matched in chunks (a level can hold hundreds of client folders); a folder two companies share is shown as such
  type Acct = { id: string; company_name: string; status: string | null; drive_folder_id: string }
  const accts: Acct[] = []
  for (let i = 0; i < rows.length; i += 100) {
    const { data, error } = await db().from("accounts").select("id, company_name, status, drive_folder_id").in("drive_folder_id", rows.slice(i, i + 100).map((r) => r.id))
    if (error) throw new Error(`Could not match the folders to companies (${error.message}).`)
    accts.push(...((data ?? []) as Acct[]))
  }
  const byFolder = new Map<string, Acct>()
  const shared = new Map<string, number>()
  for (const a of accts) { if (byFolder.has(a.drive_folder_id)) shared.set(a.drive_folder_id, (shared.get(a.drive_folder_id) ?? 1) + 1); else byFolder.set(a.drive_folder_id, a) }
  const accountIds = Array.from(byFolder.values()).map((a) => a.id)
  const runs = new Map<string, { id: string; status: string; mode: string; owner_id: string | null }>()
  for (let i = 0; i < accountIds.length; i += 100) {
    const { data: rs, error: rErr } = await db().from("store_import_runs").select("id, account_id, status, mode, owner_id, started_at").in("account_id", accountIds.slice(i, i + 100)).neq("status", "rolled_back").neq("status", "failed").order("started_at", { ascending: false })
    if (rErr) throw new Error(`Could not read the copies (${rErr.message}).`)
    for (const r of (rs ?? []) as { id: string; account_id: string; status: string; mode: string; owner_id: string | null }[]) if (!runs.has(r.account_id)) runs.set(r.account_id, r)
  }
  await Promise.all(rows.map(async (r) => {
    const a = byFolder.get(r.id)
    if (!a) return
    const extra = shared.get(r.id)
    r.company = { accountId: a.id, name: extra ? `${a.company_name} (+${extra - 1} other compan${extra - 1 === 1 ? "y" : "ies"} share this folder)` : a.company_name, status: a.status }
    const run = runs.get(a.id)
    if (run) {
      const { count } = await db().from("store_import_items").select("id", { count: "exact", head: true }).eq("run_id", run.id)
      r.copy = { runId: run.id, status: run.status, mode: run.mode === "copy" ? "copy" : "move", ownerId: run.owner_id, files: count ?? 0 }
    }
  }))
}

/** "Search everything" for the picker: CRM companies whose name contains the text (anywhere inside a word) and have a
 *  Drive folder, plus Drive folders at any level whose name contains it. Companies first. */
export async function searchDriveFolders(text: string): Promise<{ root: string; query: string; results: DriveFolderRow[]; tooShort: boolean }> {
  const root = await pickerRootDrive()
  const q = text.trim().replace(/\s+/g, " ")
  if (q.length < 2) return { root, query: q, results: [], tooShort: true }
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`
  const { data: accts, error } = await db().from("accounts").select("company_name, drive_folder_id").not("drive_folder_id", "is", null).ilike("company_name", like).order("company_name").limit(30)
  if (error) throw new Error(`Could not search the companies (${error.message}).`)
  const rows: DriveFolderRow[] = ((accts ?? []) as { company_name: string; drive_folder_id: string }[]).map((a) => ({ id: a.drive_folder_id, name: a.company_name, company: null, copy: null }))
  const seen = new Set(rows.map((r) => r.id))
  const { searchFoldersAnyDrive } = await import("@/lib/google-drive")
  for (const f of await searchFoldersAnyDrive(root, q, 30)) if (!seen.has(f.id)) { seen.add(f.id); rows.push({ id: f.id, name: f.name, company: null, copy: null }) }
  await attachCompanies(rows)
  // a CRM company whose folder is not in this Shared Drive is not offered (the copy would refuse it anyway)
  return { root, query: q, results: rows, tooShort: false }
}

/** The Shared Drive the picker opens: the TEST Drive outside production, the company Shared Drive in production. */
export async function pickerRootDrive(): Promise<string> {
  const { isProductionDatabase } = await import("@/lib/google-drive-guard")
  if (isProductionDatabase()) return companyDrive()
  const test = (process.env.STORE_TEST_DRIVE_ID || process.env.GOOGLE_SHARED_DRIVE_ID || "").trim()
  if (!test || test === PROD_DRIVE) throw new Error("No TEST Drive is set here — the picker outside production only opens the TEST Drive.")
  return test
}

/** One Drive folder's sub-folders (never files), each with the CRM company it belongs to and its copy / move. */
export async function listDriveFolders(folderId: string | null): Promise<{ root: string; folderId: string; folders: DriveFolderRow[]; files: number; cutOff: boolean }> {
  const root = await pickerRootDrive()
  const id = folderId || root
  const { getDriveItemAnyDrive, listFolderPageAnyDrive } = await import("@/lib/google-drive")
  if (id !== root) {
    const item = await getDriveItemAnyDrive(id)
    if (item.driveId !== root || item.mimeType !== GOOGLE_FOLDER) throw new Error("That folder is not in the Shared Drive the picker opens.")
  }
  const folders: Array<{ id: string; name: string }> = []
  let files = 0
  let token: string | null = null
  let pages = 0
  let cutOff = false
  do {
    const page = await listFolderPageAnyDrive(id, token)
    for (const f of page.files) { if (f.mimeType === GOOGLE_FOLDER) folders.push({ id: f.id, name: f.name }); else files++ }
    token = page.nextPageToken
    if (++pages >= 50 && token) { cutOff = true; break } // 5,000 entries — said so on screen
  } while (token)
  const rows: DriveFolderRow[] = folders.map((f) => ({ ...f, company: null, copy: null }))
  await attachCompanies(rows)
  return { root, folderId: id, folders: rows.sort((a, b) => a.name.localeCompare(b.name)), files, cutOff }
}
