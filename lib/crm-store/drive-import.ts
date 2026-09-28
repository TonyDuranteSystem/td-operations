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

export type ItemStatus = "pending" | "done" | "merged" | "skipped" | "failed"
export interface ImportItem {
  id: string; run_id: string; source: "drive" | "storage"; source_id: string; drive_path: string[]; name: string
  mime_type: string | null; size_bytes: number | null; source_md5: string | null; status: ItemStatus; reason: string | null
  store_file_id: string | null; sha256: string | null; landed_in: string | null
  repointed: Array<{ id: string; drive_file_id: string; drive_link: string | null; created?: boolean }>
}
export interface RunView {
  id: string; accountId: string; ownerId: string | null; status: string; startedAt: string; finishedAt: string | null
  counts: { total: number; pending: number; done: number; merged: number; skipped: number; failed: number }
  report: ImportReport | null
}
export interface ImportReport {
  folders: Array<{ folder: string; driveFiles: number; driveBytes: number; moved: number; movedBytes: number; merged: number; skipped: number; failed: number; checksumChecked: number }>
  rowsRepointed: number; rowsCreated: number; fromStorage: number
  skipped: Array<{ name: string; where: string; reason: string }>
  failed: Array<{ name: string; where: string; reason: string }>
  needsReview: number
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
  }
  if (p.members.length === 1) return p.members[0].contactId
  return null
}

/** Pure: the parity report of a run from its ledger rows. Parity holds when nothing failed and nothing is pending. */
export function buildReport(items: ImportItem[], stillReadDrive: string[]): ImportReport {
  const byFolder = new Map<string, ImportReport["folders"][number]>()
  const top = (it: ImportItem) => (it.source === "storage" ? "(files kept outside Drive)" : it.drive_path[0] ?? "(top of the Drive folder)")
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
  const where = (it: ImportItem) => (it.source === "storage" ? "outside Drive" : it.drive_path.join(" › ") || "top of the Drive folder")
  return {
    folders: Array.from(byFolder.values()).sort((a, b) => a.folder.localeCompare(b.folder)),
    rowsRepointed: items.reduce((n, it) => n + it.repointed.filter((r) => !r.created).length, 0),
    rowsCreated: items.reduce((n, it) => n + it.repointed.filter((r) => r.created).length, 0),
    fromStorage: items.filter((it) => it.source === "storage" && (it.status === "done" || it.status === "merged")).length,
    skipped: items.filter((it) => it.status === "skipped").map((it) => ({ name: it.name, where: where(it), reason: it.reason ?? "" })),
    failed: items.filter((it) => it.status === "failed").map((it) => ({ name: it.name, where: where(it), reason: it.reason ?? "" })),
    needsReview: items.filter((it) => /needs review/i.test(it.reason ?? "")).length,
    parityOk: items.every((it) => it.status !== "failed" && it.status !== "pending"),
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
async function assertMayImportFrom(driveFolderId: string): Promise<void> {
  const { pilotEnvironmentAllowed } = await import("./formation-pilot")
  if (!pilotEnvironmentAllowed()) throw new Error("Moving a company to the new storage is not switched on here.")
  const { isProductionDatabase } = await import("@/lib/google-drive-guard")
  const { getDriveItemAnyDrive } = await import("@/lib/google-drive")
  const item = await getDriveItemAnyDrive(driveFolderId)
  if (item.mimeType !== GOOGLE_FOLDER) throw new Error("The company's Drive link is not a folder.")
  if (!isProductionDatabase()) {
    const test = (process.env.STORE_TEST_DRIVE_ID || process.env.GOOGLE_SHARED_DRIVE_ID || "").trim()
    if (!test || test === PROD_DRIVE) throw new Error("No TEST Drive is set here — a move outside production only reads the TEST Drive.")
    if (item.driveId !== test) throw new Error("This company's Drive folder is not in the TEST Drive — outside production only test folders may be moved (sandbox companies point at real client folders).")
  }
}

// ─────────────────────────────────────────────────────────────── start

/** Start (or resume) the move of one company. Scans the Drive folder and the company's storage: rows into the ledger. */
export async function startDriveImport(accountId: string, actorId: string | null): Promise<RunView> {
  const { data: acct, error: aErr } = await db().from("accounts").select("id, company_name, drive_folder_id").eq("id", accountId).maybeSingle()
  if (aErr) throw new Error(`Could not read the company (${aErr.message}).`)
  if (!acct) throw new Error("Company not found.")
  // an open run continues — never a second one
  const { data: open } = await db().from("store_import_runs").select("id").eq("account_id", accountId).in("status", ["scanning", "moving"]).maybeSingle()
  if (open?.id) return runView(open.id as string)
  const { data: doneRun } = await db().from("store_import_runs").select("id").eq("account_id", accountId).in("status", ["done", "incomplete"]).limit(1).maybeSingle()
  if (doneRun?.id) throw new Error("This company has already been moved to the new storage — undo that move first to run it again.")
  if (!acct.drive_folder_id) throw new Error("This company has no Drive folder to move.")
  await assertMayImportFrom(acct.drive_folder_id as string)

  const { data: run, error: rErr } = await db().from("store_import_runs")
    .insert({ account_id: accountId, drive_folder_id: acct.drive_folder_id, status: "scanning", started_by: actorId }).select("id").single()
  if (rErr) throw new Error(/uq_store_import_runs_open|duplicate/i.test(rErr.message) ? "A move of this company is already running." : `The move could not start (${rErr.message}).`)
  try {
    // the company's storage and its 5 standard folders (idempotent)
    const { data: ownerId, error: oErr } = await db().rpc("store_ensure_owner", { p_kind: "company", p_ref: accountId })
    if (oErr || !ownerId) throw new Error(`The company's storage could not be created (${oErr?.message ?? "no id"}).`)
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

type ScanItem = Pick<ImportItem, "source" | "source_id" | "drive_path" | "name" | "mime_type" | "size_bytes" | "source_md5">

async function scanDrive(rootId: string): Promise<ScanItem[]> {
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
  members: Array<{ contactId: string; name: string }>
  types: Map<string, { slug: string; display: string; personal: boolean; staffOnly: boolean; draftNeverVisible: boolean; legacyId: number | null }>
  folderByKind: Map<string, string>
}

/** Move the next batch of files. Returns the run's state; call again while it says "moving". */
export async function continueDriveImport(runId: string, actorId: string | null, budget = { files: IMPORT_BATCH_FILES, ms: IMPORT_BATCH_MS }): Promise<RunView> {
  const t0 = Date.now()
  const { data: run, error } = await db().from("store_import_runs").select("id, account_id, owner_id, status").eq("id", runId).maybeSingle()
  if (error) throw new Error(`Could not read the move (${error.message}).`)
  if (!run) throw new Error("Move not found.")
  if (run.status !== "moving") return runView(runId)
  const ctx = await loadCtx(run.id, run.account_id, run.owner_id, actorId)
  const { data: pending, error: pErr } = await db().from("store_import_items").select("*").eq("run_id", runId).eq("status", "pending").order("drive_path").order("name").limit(budget.files)
  if (pErr) throw new Error(`Could not read the files to move (${pErr.message}).`)
  for (const it of (pending ?? []) as ImportItem[]) {
    if (Date.now() - t0 > budget.ms) break
    let patch: Partial<ImportItem>
    try { patch = await moveOne(it, ctx) } catch (e) { patch = { status: "failed", reason: e instanceof Error ? e.message : String(e) } }
    // only a still-pending item is written (a parallel batch may have done it)
    await db().from("store_import_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", it.id).eq("status", "pending")
  }
  const { count } = await db().from("store_import_items").select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", "pending")
  if ((count ?? 0) === 0) await finishRun(runId, run.owner_id)
  return runView(runId)
}

async function loadCtx(runId: string, accountId: string, ownerId: string, actorId: string | null): Promise<Ctx> {
  const [{ data: links, error: lErr }, { data: types, error: tErr }, { data: folders, error: fErr }] = await Promise.all([
    db().from("account_contacts").select("contact_id, contacts(full_name)").eq("account_id", accountId),
    db().from("catalog_entries").select("slug, display_name, metadata").eq("catalog_id", "storage_document_types"),
    db().from("store_folders").select("id, kind, parent_id").eq("owner_id", ownerId).is("trashed_at", null),
  ])
  if (lErr || tErr || fErr) throw new Error(`Could not read the company's set-up (${(lErr ?? tErr ?? fErr).message}).`)
  const members = ((links ?? []) as { contact_id: string; contacts: { full_name: string | null } | null }[])
    .map((l) => ({ contactId: l.contact_id, name: l.contacts?.full_name ?? "" }))
  const typeMap = new Map<string, Ctx["types"] extends Map<string, infer V> ? V : never>()
  for (const t of (types ?? []) as { slug: string; display_name: string; metadata: Record<string, unknown> | null }[]) {
    const m = t.metadata ?? {}
    const v = { slug: t.slug, display: t.display_name, personal: m.personal === true, staffOnly: m.staff_only === true, draftNeverVisible: m.draft_never_visible === true, legacyId: typeof m.legacy_document_type_id === "number" ? m.legacy_document_type_id : null }
    typeMap.set(`slug:${t.slug}`, v)
    typeMap.set(`name:${t.display_name.trim().toLowerCase()}`, v)
    if (v.legacyId != null) typeMap.set(`legacy:${v.legacyId}`, v)
  }
  const folderByKind = new Map<string, string>()
  for (const f of (folders ?? []) as { id: string; kind: string; parent_id: string | null }[]) if (f.parent_id && !folderByKind.has(f.kind)) folderByKind.set(f.kind, f.id)
  return { runId, accountId, companyOwner: ownerId, actorId, members, types: typeMap, folderByKind }
}

interface DocRow { id: string; drive_file_id: string; drive_link: string | null; document_type_id: number | null; document_type_name: string | null; category: number | null; contact_id: string | null; account_id: string | null; portal_visible: boolean | null; tax_year: number | null }

async function moveOne(it: ImportItem, ctx: Ctx): Promise<Partial<ImportItem>> {
  const skip = it.source === "drive" ? skipReasonFor(it.mime_type) : null
  if (skip) return { status: "skipped", reason: skip }
  if (it.size_bytes != null && it.size_bytes > IMPORT_MAX_FILE_BYTES) return { status: "failed", reason: `Too large for the new storage (${Math.round(it.size_bytes / 1048576)} MB, limit ${IMPORT_MAX_FILE_BYTES / 1048576} MB).` }

  // the CRM rows of this file (this company's, or a member's personal row)
  const memberIds = ctx.members.map((m) => m.contactId)
  const { data: rowsRaw, error: rErr } = await db().from("documents")
    .select("id, drive_file_id, drive_link, document_type_id, document_type_name, category, contact_id, account_id, portal_visible, tax_year").eq("drive_file_id", it.source_id)
  if (rErr) throw new Error(`Could not read the CRM record (${rErr.message}).`)
  const rows = ((rowsRaw ?? []) as DocRow[]).filter((r) => r.account_id === ctx.accountId || (!r.account_id && r.contact_id && memberIds.includes(r.contact_id)))

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
  if (it.size_bytes != null && it.source === "drive" && bytes.length !== Number(it.size_bytes)) return { status: "failed", reason: `Came back ${bytes.length} bytes, Drive says ${it.size_bytes} — not moved.` }
  if (it.source_md5 && md5Hex(bytes) !== it.source_md5) return { status: "failed", reason: "The content does not match Drive's fingerprint — not moved." }
  const sha = sha256Hex(bytes)

  // type, visibility, year
  const row0 = rows[0] ?? null
  const type = row0 ? (row0.document_type_id != null ? ctx.types.get(`legacy:${row0.document_type_id}`) : undefined) ?? (row0.document_type_name ? ctx.types.get(`name:${row0.document_type_name.trim().toLowerCase()}`) : undefined) ?? null : null
  const visible = rows.some((r) => r.portal_visible === true)

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
      ownerId = await ensurePersonOwner(person, name)
      folderId = await folderOfKind(ownerId, "personal")
      subPath = [] // a person's own documents sit in "Personal documents"
      // the same document already in this person's storage → kept once
      const dup = await sameContentFile(ownerId, sha)
      if (dup) return await mergeInto(it, dup, rows, ctx)
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

  // a name already taken by ANOTHER file in that folder → "Name (2).ext"
  const callerKey = `drive-import:${it.source}:${it.source_id}`
  const name = await freeName(folderId, it.name, callerKey)
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
  if (needsReview) {
    const { markNeedsReview } = await import("./structure")
    await markNeedsReview(w.fileId, needsReview, ctx.actorId)
  }
  // the client sees exactly what they saw before
  let note: string | null = needsReview
  if (visible && !needsReview) {
    const { error } = await db().rpc("store_set_published", { p_file_id: w.fileId, p_published: true, p_actor: ctx.actorId })
    if (error) note = `The client could see this before; the new storage keeps it hidden (${error.message.replace(/^store: /, "")}) — the CRM record still shows it. Check.`
  }
  const repointed = await repointRows(rows, w.fileId, ownerId, folderId, it, ctx, visible && !needsReview)
  if (it.source === "drive") {
    const { error } = await db().rpc("store_import_record_ref", { p_file_id: w.fileId, p_drive_file_id: it.source_id, p_sha256: sha, p_drive_path: { area: "import", path: it.drive_path } })
    if (error) note = `${note ? `${note} ` : ""}The backup could not record the Drive original (${error.message}).`
  }
  return { status: "done", store_file_id: w.fileId, sha256: sha, landed_in: await pathOf(folderId, ownerId), repointed, reason: note }
}

/** A member named by the CRM record of an IDENTICAL Drive file (same md5) in this same move, else null. */
async function personBySameContent(ctx: Ctx, it: ImportItem): Promise<string | null> {
  const { data, error } = await db().from("store_import_items").select("source_id").eq("run_id", ctx.runId).eq("source", "drive").eq("source_md5", it.source_md5).neq("id", it.id)
  if (error || !data?.length) return null
  const ids = (data as { source_id: string }[]).map((x) => x.source_id)
  const { data: rows } = await db().from("documents").select("contact_id").in("drive_file_id", ids).not("contact_id", "is", null)
  const members = new Set(ctx.members.map((m) => m.contactId))
  const found = Array.from(new Set(((rows ?? []) as { contact_id: string }[]).map((r) => r.contact_id).filter((c) => members.has(c))))
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

async function sameContentFile(ownerId: string, sha: string): Promise<string | null> {
  const { data, error } = await db().from("store_files").select("id, store_file_versions!store_files_current_version_fk!inner(sha256)")
    .eq("owner_id", ownerId).eq("state", "live").eq("store_file_versions.sha256", sha).limit(1)
  if (error) throw new Error(`Could not check for an identical file (${error.message}).`)
  return ((data ?? [])[0]?.id as string | undefined) ?? null
}

async function mergeInto(it: ImportItem, fileId: string, rows: DocRow[], ctx: Ctx): Promise<Partial<ImportItem>> {
  // its rows follow the kept copy when that copy has no row yet (one row per stored file); else they stay on Drive
  const { storePointer } = await import("./document-pointer")
  const { data: taken } = await db().from("documents").select("id").eq("drive_file_id", storePointer(fileId)).limit(1)
  let repointed: ImportItem["repointed"] = []
  let reason = "The same document is already in this person's storage — kept once."
  const live = rows.filter((r) => !r.drive_file_id.startsWith("store:"))
  if (live.length) {
    // the kept file only has the placeholder row THIS move listed (its first copy had no CRM record): the real
    // record takes its place — the placeholder goes, the real one follows the store with its own visibility
    const placeholder = taken?.length ? await placeholderOf(ctx.runId, taken[0].id as string) : null
    if (placeholder) {
      const { error } = await db().from("documents").delete().eq("id", placeholder.rowId).eq("drive_file_id", storePointer(fileId))
      if (error) throw new Error(`The listed copy could not be replaced by the CRM record (${error.message}).`)
      await db().from("store_import_items").update({ repointed: placeholder.rest, updated_at: new Date().toISOString() }).eq("id", placeholder.itemId)
    }
    if (!taken?.length || placeholder) {
      const vis = live.some((r) => r.portal_visible === true)
      repointed = await repointRows(live, fileId, null, null, it, ctx, vis)
      if (vis) {
        const { error } = await db().rpc("store_set_published", { p_file_id: fileId, p_published: true, p_actor: ctx.actorId })
        if (error) reason += ` The client could see it before; the new storage keeps it hidden (${error.message.replace(/^store: /, "")}) — check.`
      }
    } else {
      reason += " Its CRM record still points to Drive."
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
  const { data, error } = await db().from("store_files").select("name, caller_key").eq("folder_id", folderId).neq("state", "purged")
  if (error) throw new Error(`Could not read the folder (${error.message}).`)
  const files = (data ?? []) as { name: string; caller_key: string | null }[]
  if (files.some((f) => f.caller_key === callerKey)) return files.find((f) => f.caller_key === callerKey)!.name // a re-run: same file
  const { storeNameKey } = await import("./rules")
  if (!files.some((f) => storeNameKey(f.name) === storeNameKey(name))) return name
  const { keepBothName } = await import("./names")
  return keepBothName(name, files.map((f) => f.name))
}

/** Re-point this file's CRM rows in place (old pointers kept for undo); no row → one hidden row is listed. */
async function repointRows(rows: DocRow[], fileId: string, ownerId: string | null, folderId: string | null, it: ImportItem, ctx: Ctx, visible: boolean): Promise<ImportItem["repointed"]> {
  const { storePointer, storeDocumentLink } = await import("./document-pointer")
  const pointer = storePointer(fileId)
  const out: ImportItem["repointed"] = []
  const live = rows.filter((r) => !r.drive_file_id.startsWith("store:"))
  if (live.length > 1) {
    // one row per stored file: the first follows the store, the others stay on Drive (reported)
    live.splice(1)
  }
  for (const r of live) {
    const { error } = await db().from("documents").update({ drive_file_id: pointer, drive_link: storeDocumentLink(r.id), updated_at: new Date().toISOString() }).eq("id", r.id).eq("drive_file_id", r.drive_file_id)
    if (error) throw new Error(`The CRM record could not be re-pointed (${error.message}).`)
    out.push({ id: r.id, drive_file_id: r.drive_file_id, drive_link: r.drive_link })
  }
  if (!rows.length && ownerId && folderId) {
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

async function pathOf(folderId: string, ownerId: string): Promise<string> {
  const { data } = await db().from("store_folders").select("id, name, parent_id").eq("owner_id", ownerId)
  const { pathOf: p } = await import("./extras")
  return p(folderId, new Map(((data ?? []) as { id: string; name: string; parent_id: string | null }[]).map((f) => [f.id, f])))
}

async function finishRun(runId: string, ownerId: string): Promise<void> {
  const { data } = await db().from("store_import_items").select("*").eq("run_id", runId)
  const report = buildReport((data ?? []) as ImportItem[], STILL_READ_DRIVE)
  const status = report.parityOk ? "done" : "incomplete"
  await db().from("store_import_runs").update({ status, report, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", runId).eq("status", "moving")
  // the 6-month backup window starts the day a company is switched (only when everything came over)
  if (report.parityOk) await db().rpc("store_backup_mark_switched", { p_owner_id: ownerId })
}

// ─────────────────────────────────────────────────────────────── view + undo

export async function runView(runId: string): Promise<RunView> {
  const { data: run, error } = await db().from("store_import_runs").select("*").eq("id", runId).maybeSingle()
  if (error) throw new Error(`Could not read the move (${error.message}).`)
  if (!run) throw new Error("Move not found.")
  const { data: items } = await db().from("store_import_items").select("status").eq("run_id", runId)
  const counts = { total: 0, pending: 0, done: 0, merged: 0, skipped: 0, failed: 0 }
  for (const it of (items ?? []) as { status: ItemStatus }[]) { counts.total++; counts[it.status]++ }
  const rep = run.report && typeof run.report === "object" && "folders" in run.report ? run.report as ImportReport : null
  return { id: run.id, accountId: run.account_id, ownerId: run.owner_id, status: run.status, startedAt: run.started_at, finishedAt: run.finished_at, counts, report: rep }
}

/** The latest move of a company (for its page), or null. */
export async function latestRunFor(accountId: string): Promise<RunView | null> {
  const { data } = await db().from("store_import_runs").select("id").eq("account_id", accountId).order("started_at", { ascending: false }).limit(1).maybeSingle()
  return data?.id ? runView(data.id as string) : null
}

/** When this company was moved to the new storage (its latest move that was not undone), else null. */
export async function movedAt(accountId: string): Promise<{ status: string; finishedAt: string | null; startedAt: string } | null> {
  const { data, error } = await db().from("store_import_runs").select("status, finished_at, started_at").eq("account_id", accountId)
    .in("status", ["moving", "done", "incomplete"]).order("started_at", { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return null
  return { status: data.status, finishedAt: data.finished_at, startedAt: data.started_at }
}

/** Undo a move: every re-pointed CRM record gets its Drive pointer back, rows the move listed are removed, the
 *  moved files go to the trash, the backup's import records are dropped. Drive was never changed. */
export async function undoDriveImport(runId: string, actorId: string | null): Promise<RunView> {
  if (!actorId) throw new Error("Only a signed-in staff member can undo a move.")
  const { data: run, error } = await db().from("store_import_runs").select("id, status, owner_id").eq("id", runId).maybeSingle()
  if (error) throw new Error(`Could not read the move (${error.message}).`)
  if (!run) throw new Error("Move not found.")
  if (run.status === "rolled_back") return runView(runId)
  if (run.status === "scanning") throw new Error("Wait for the scan to finish, then undo.")
  const { data: itemsRaw } = await db().from("store_import_items").select("*").eq("run_id", runId)
  const items = (itemsRaw ?? []) as ImportItem[]
  // stop the batches first
  await db().from("store_import_runs").update({ status: "incomplete", updated_at: new Date().toISOString() }).eq("id", runId).eq("status", "moving")
  for (const it of items) {
    for (const r of it.repointed) {
      if (r.created) await db().from("documents").delete().eq("id", r.id).eq("drive_file_id", r.drive_file_id)
      else await db().from("documents").update({ drive_file_id: r.drive_file_id, drive_link: r.drive_link, updated_at: new Date().toISOString() }).eq("id", r.id).like("drive_file_id", "store:%")
    }
  }
  const { deleteStoreFile } = await import("./file-actions")
  const fileIds = Array.from(new Set(items.filter((it) => it.status === "done" && it.store_file_id).map((it) => it.store_file_id as string)))
  const problems: string[] = []
  for (const id of fileIds) {
    const { data: f } = await db().from("store_files").select("state").eq("id", id).maybeSingle()
    if (f?.state === "live") { try { await deleteStoreFile(id, actorId) } catch (e) { problems.push(e instanceof Error ? e.message : String(e)) } }
    await db().from("store_external_refs").delete().eq("object_kind", "file").eq("object_id", id).eq("direction", "import")
  }
  if (run.owner_id) await db().from("store_backup_state").update({ switched_at: null, updated_at: new Date().toISOString() }).eq("owner_id", run.owner_id)
  await db().from("store_import_runs").update({ status: "rolled_back", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { undone: true, problems } }).eq("id", runId)
  return runView(runId)
}
