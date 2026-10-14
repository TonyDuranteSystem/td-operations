/**
 * Drive → storage CATCH-UP (dev job ad09ea91, owner-only, one company at a time).
 *
 * WHY. The go-live (v2 "clean listing") deliberately leaves the records the CRM made AFTER a company's approved copy on Drive
 * (signed tax returns, IRS fax receipts, EIN letters …): their bytes are not in the storage. This brings them in, ONE CRM RECORD AT A
 * TIME, and re-points exactly that record (never a sibling that shares the Drive file) to the stored copy.
 *
 * SURGICAL BY DESIGN (every rule below came from a council review):
 *  - purpose-built: it does NOT reuse the old move engine (which re-points every row of a Drive file, can flip a person's study copy
 *    live and reports as the company's move). Its run is tagged `catchUp` — never `goLive` — and the move code refuses such a run;
 *  - only records made after the approved copy, with a real Drive id, no workspace link, not personal, not archived, one per Drive file;
 *  - the SAME record follows the file (only its pointer and link change); ledger first, so every change can be undone;
 *  - the client sees what they saw: a typed file the client can see stays visible; an untyped one (or one the storage may not show)
 *    stays on Drive and is LISTED for staff; a hidden one stays hidden;
 *  - one key per RECORD (`catch-up:<record id>`): running it twice never makes a second copy;
 *  - every byte is checked against Drive's md5 before the record moves, and again from storage afterwards; a mismatch is put back;
 *  - Drive is never written; the company is never switched or un-switched; a person's storage is never touched.
 */
import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
const db = () => supabaseAdmin as any

export const CATCH_UP_STALE_MINUTES = 30
export const CATCH_UP_BUDGET_MS = 200_000
/** Never start a file with less than this left: a download + hash + store + read-back can take a minute. */
const MIN_TIME_PER_FILE_MS = 60_000
const MAX_FILE_BYTES = 50 * 1024 * 1024
/** A real Google Drive file id: letters, digits, "-" and "_" only — no ":" (pseudo pointers like "ss4-live:…"). */
const DRIVE_ID = /^[A-Za-z0-9_-]{15,}$/
const PAGE = 1000

export interface CatchUpRow {
  id: string
  file_name: string | null
  drive_file_id: string
  drive_link?: string | null
  document_type_name: string | null
  document_type_id?: number | null
  category?: number | null
  tax_year?: number | null
  created_at: string
  portal_visible: boolean | null
  service_delivery_id: string | null
  flow_stage: string | null
  contact_id: string | null
  account_id: string | null
  status: string | null
}

export type CatchUpVerdict = { eligible: true } | { eligible: false; reason: string }

/** PURE: may this CRM record be brought in? (every "no" says why — it appears in the report, nothing is silent) */
export function classifyCatchUpRow(row: CatchUpRow, copyStartedAt: string | null): CatchUpVerdict {
  const ptr = row.drive_file_id ?? ""
  if (ptr.startsWith("store:") || ptr.startsWith("storage:")) return { eligible: false, reason: "already in the new storage" }
  if (row.status === "archived") return { eligible: false, reason: "archived" }
  if (!DRIVE_ID.test(ptr)) return { eligible: false, reason: "not a real Drive file (an internal pointer)" }
  if (!copyStartedAt) return { eligible: false, reason: "this company has no approved copy to compare with" }
  if (!(Date.parse(row.created_at) > Date.parse(copyStartedAt))) return { eligible: false, reason: "older than the approved copy (left on Drive on purpose)" }
  if (row.service_delivery_id || row.flow_stage) return { eligible: false, reason: "a workspace document (left on Drive on purpose)" }
  if (row.contact_id && !row.account_id) return { eligible: false, reason: "a personal record of a person" }
  return { eligible: true }
}

/**
 * PURE: the Drive file ids that more than one CRM record points at (this company's other records, or anyone's). Such a file is left alone:
 * re-pointing one record would leave its sibling on Drive and a later run would store the same bytes twice. Staff resolve it by hand.
 */
export function sharedDriveIds(eligible: Array<{ id: string; driveFileId: string }>, allCompanyRows: Array<{ id: string; drive_file_id: string }>, otherRows: Array<{ id: string; drive_file_id: string }>): Set<string> {
  const count = new Map<string, Set<string>>()
  const add = (driveId: string, id: string) => { const s = count.get(driveId) ?? new Set<string>(); s.add(id); count.set(driveId, s) }
  for (const r of allCompanyRows) add(r.drive_file_id, r.id)
  for (const r of otherRows) add(r.drive_file_id, r.id)
  const shared = new Set<string>()
  for (const e of eligible) if ((count.get(e.driveFileId)?.size ?? 0) > 1) shared.add(e.driveFileId)
  return shared
}

export interface CatchUpPlan {
  accountId: string
  companyName: string | null
  ownerId: string | null
  copyStartedAt: string | null
  eligible: Array<{ id: string; name: string; type: string | null; clientSeesIt: boolean; driveFileId: string }>
  skipped: Array<{ id: string; name: string; reason: string }>
  blockers: string[]
  planHash: string
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex")
const md5Hex = (b: Buffer) => createHash("md5").update(b).digest("hex")

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(`could not read ${what} (${error.message})`)
  return (data ?? ([] as unknown)) as T
}

/** Every row, a page at a time (PostgREST answers at most 1000 rows per request — a cut-off list would silently hide records). */
async function readAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const page = await must<T[]>(build(from, from + PAGE - 1), what)
    all.push(...page)
    if (page.length < PAGE) return all
  }
}

const ROW_COLS = "id, file_name, drive_file_id, drive_link, document_type_name, document_type_id, category, tax_year, created_at, portal_visible, service_delivery_id, flow_stage, contact_id, account_id, status"

export async function planCatchUp(accountId: string): Promise<CatchUpPlan> {
  const d = db()
  const blockers: string[] = []
  const { data: acct } = await d.from("accounts").select("id, company_name").eq("id", accountId).maybeSingle()
  if (!acct) return { accountId, companyName: null, ownerId: null, copyStartedAt: null, eligible: [], skipped: [], blockers: ["Company not found."], planHash: "" }
  const owners = await must<Array<{ id: string }>>(d.from("store_owners").select("id").eq("account_id", accountId).eq("kind", "company").eq("study_only", false).limit(2), "the company's storage")
  if (owners.length !== 1) blockers.push(owners.length === 0 ? "This company is not switched to the new storage." : "This company has more than one live storage — a person must look at it first.")
  const open = await must<Array<{ id: string }>>(d.from("store_import_runs").select("id").eq("account_id", accountId).eq("mode", "move").in("status", ["scanning", "moving", "undoing"]).limit(1), "open moves")
  if (open.length) blockers.push("A move, switch or catch-up is already open for this company.")
  const copies = await must<Array<{ started_at: string }>>(d.from("store_import_runs").select("started_at").eq("account_id", accountId).eq("mode", "copy").eq("status", "done").order("started_at", { ascending: false }).limit(1), "the approved copy")
  const copyStartedAt = copies[0]?.started_at ?? null
  if (!copyStartedAt) blockers.push("This company has no finished approved copy to compare with.")
  const rows = await readAll<CatchUpRow>(
    (from, to) => d.from("documents").select(ROW_COLS).eq("account_id", accountId).not("drive_file_id", "like", "store:%").not("drive_file_id", "like", "storage:%").neq("status", "archived").order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
    "the company's Drive-pointing records",
  )
  const eligible: CatchUpPlan["eligible"] = []
  const skipped: CatchUpPlan["skipped"] = []
  for (const r of rows) {
    const v = classifyCatchUpRow(r, copyStartedAt)
    if (v.eligible) eligible.push({ id: r.id, name: r.file_name ?? "(no name)", type: r.document_type_name, clientSeesIt: r.portal_visible === true, driveFileId: r.drive_file_id })
    else skipped.push({ id: r.id, name: r.file_name ?? "(no name)", reason: (v as { reason: string }).reason })
  }
  // a Drive file that several records point at: none of them is touched (listed for staff)
  const eligibleIds = Array.from(new Set(eligible.map((e) => e.driveFileId)))
  const others: Array<{ id: string; drive_file_id: string }> = []
  for (let i = 0; i < eligibleIds.length; i += 100) {
    others.push(...(await readAll<{ id: string; drive_file_id: string }>((from, to) => d.from("documents").select("id, drive_file_id").in("drive_file_id", eligibleIds.slice(i, i + 100)).neq("status", "archived").neq("account_id", accountId).range(from, to), "other records of the same Drive files")))
    others.push(...(await readAll<{ id: string; drive_file_id: string }>((from, to) => d.from("documents").select("id, drive_file_id").in("drive_file_id", eligibleIds.slice(i, i + 100)).neq("status", "archived").is("account_id", null).range(from, to), "personal records of the same Drive files")))
  }
  const shared = sharedDriveIds(eligible, rows.filter((r) => r.status !== "archived"), others)
  const keep = eligible.filter((e) => !shared.has(e.driveFileId))
  for (const x of eligible.filter((e) => shared.has(e.driveFileId))) skipped.push({ id: x.id, name: x.name, reason: "its Drive file is shared with another CRM record — left alone for staff to resolve" })
  return { accountId, companyName: acct.company_name ?? null, ownerId: owners[0]?.id ?? null, copyStartedAt, eligible: keep, skipped, blockers, planHash: sha1(JSON.stringify({ accountId, copyStartedAt, ids: keep.map((e) => `${e.id}:${e.driveFileId}`) })) }
}

/** Every company with something to catch up (reads only). */
export async function listCatchUp(): Promise<Array<{ accountId: string; companyName: string | null; eligible: number }>> {
  const d = db()
  const owners = await readAll<{ account_id: string }>((from, to) => d.from("store_owners").select("account_id").eq("kind", "company").eq("study_only", false).not("account_id", "is", null).order("id", { ascending: true }).range(from, to), "the switched companies")
  const out: Array<{ accountId: string; companyName: string | null; eligible: number }> = []
  const ids = Array.from(new Set(owners.map((o) => o.account_id)))
  for (let i = 0; i < ids.length; i += 25) {
    const part = ids.slice(i, i + 25)
    const rows = await readAll<CatchUpRow & { accounts: { company_name: string | null } | null }>(
      (from, to) => d.from("documents").select(`${ROW_COLS}, accounts(company_name)`).in("account_id", part).not("drive_file_id", "like", "store:%").not("drive_file_id", "like", "storage:%").neq("status", "archived").order("id", { ascending: true }).range(from, to),
      "the Drive-pointing records",
    )
    if (!rows.length) continue
    const copies = await must<Array<{ account_id: string; started_at: string }>>(d.from("store_import_runs").select("account_id, started_at").in("account_id", part).eq("mode", "copy").eq("status", "done"), "the copies")
    const copyAt = new Map<string, string>()
    for (const c of copies) if (!copyAt.has(c.account_id) || c.started_at > (copyAt.get(c.account_id) as string)) copyAt.set(c.account_id, c.started_at)
    const per = new Map<string, { name: string | null; files: Set<string> }>()
    for (const r of rows) {
      if (!classifyCatchUpRow(r, copyAt.get(r.account_id as string) ?? null).eligible) continue
      const e = per.get(r.account_id as string) ?? { name: r.accounts?.company_name ?? null, files: new Set<string>() }
      e.files.add(r.drive_file_id)
      per.set(r.account_id as string, e)
    }
    for (const [accountId, e] of Array.from(per.entries())) out.push({ accountId, companyName: e.name, eligible: e.files.size })
  }
  return out.sort((a, b) => b.eligible - a.eligible)
}

export interface CatchUpItemResult { id: string; name: string; outcome: "brought_in" | "kept_on_drive" | "failed" | "put_back"; detail: string }
export interface CatchUpResult { ok: boolean; message: string; runId: string | null; items: CatchUpItemResult[]; plan: CatchUpPlan | null }

type LedgerEntry = { id: string; drive_file_id: string; drive_link: string | null; before?: Record<string, unknown>; created?: boolean; archived?: boolean }

function kindForCategory(c: number | null | undefined): "company" | "tax" | "banking" | "correspondence" {
  return c === 1 ? "company" : c === 3 ? "tax" : c === 4 ? "banking" : "correspondence"
}

interface RunCtx {
  runId: string
  accountId: string
  ownerId: string
  actorId: string
  types: Awaited<ReturnType<typeof loadTypes>>
  folderByKind: Map<string, string>
}

async function loadTypes() {
  const { loadTypeMap } = await import("./drive-import")
  const rows = await must<unknown[]>(db().from("catalog_entries").select("slug, display_name, metadata").eq("catalog_id", "storage_document_types"), "the document types")
  return loadTypeMap(rows)
}

/** ONE record: bring its Drive file in, then re-point exactly this record. Never throws for a file problem. */
async function catchUpOne(e: CatchUpPlan["eligible"][number], ctx: RunCtx): Promise<CatchUpItemResult> {
  const d = db()
  const res = (outcome: CatchUpItemResult["outcome"], detail: string): CatchUpItemResult => ({ id: e.id, name: e.name, outcome, detail })
  // the record, fresh: it may have changed since the preview
  const { data: row } = await d.from("documents").select(ROW_COLS).eq("id", e.id).maybeSingle()
  if (!row) return res("failed", "the record is gone")
  const r = row as CatchUpRow
  if (r.drive_file_id !== e.driveFileId || r.drive_file_id.startsWith("store:") || r.status === "archived") return res("kept_on_drive", "the record changed since the preview — left as it is")

  const { getFileMetadata, getDriveFileChecksum, downloadBinaryAnyDrive } = await import("@/lib/google-drive")
  const meta = (await getFileMetadata(e.driveFileId)) as { name?: string; mimeType?: string; size?: string }
  const sum = await getDriveFileChecksum(e.driveFileId)
  const mime = meta.mimeType ?? sum.mimeType
  if ((mime ?? "").startsWith("application/vnd.google-apps")) return res("kept_on_drive", "a Google Docs/Sheets file — it cannot be copied as it is; it stays on Drive")
  const size = sum.size ?? (meta.size ? Number(meta.size) : null)
  if (size != null && size > MAX_FILE_BYTES) return res("failed", `too large for the new storage (${Math.round(size / 1048576)} MB)`)

  const { typeOfRow } = await import("./drive-import")
  const type = typeOfRow(ctx.types, { document_type_id: r.document_type_id ?? null, document_type_name: r.document_type_name } as { document_type_id: number | null; document_type_name: string | null }) as { slug: string; personal: boolean; staffOnly: boolean; draftNeverVisible: boolean } | null
  if (type?.personal === true || r.category === 2) return res("kept_on_drive", "a personal document (passport, ID …) — it stays on Drive; staff file it in the person's storage")

  const bytes = await downloadBinaryAnyDrive(e.driveFileId)
  if (bytes.length > MAX_FILE_BYTES) return res("failed", `too large for the new storage (${Math.round(bytes.length / 1048576)} MB)`)
  if (sum.md5 ? md5Hex(bytes) !== sum.md5 : size != null && bytes.length !== size) return res("failed", "the downloaded bytes do not match Drive's fingerprint — nothing was stored")

  const folderId = ctx.folderByKind.get(kindForCategory(r.category))
  if (!folderId) return res("failed", "the company's folder for this document is missing in the new storage")
  const callerKey = `catch-up:${r.id}`
  const { storeSafeFileName } = await import("./formation-pilot")
  const { storeNameKey } = await import("./rules")
  const files = await must<Array<{ name: string; caller_key: string | null }>>(d.from("store_files").select("name, caller_key").eq("folder_id", folderId).eq("state", "live"), "the folder")
  const same = files.find((f) => f.caller_key === callerKey)
  let name = same?.name ?? storeSafeFileName(meta.name || r.file_name || "document")
  if (!same && files.some((f) => storeNameKey(f.name) === storeNameKey(name))) { const { keepBothName } = await import("./names"); name = keepBothName(name, files.map((f) => f.name)) }
  const visible = r.portal_visible === true
  const { saveBytesToStore } = await import("./writer")
  const w = await saveBytesToStore({
    ownerId: ctx.ownerId, folderId, name, mimeType: mime ?? null, bytes, callerKey, contentChanged: true, documentType: type?.slug ?? null, published: false, actor: ctx.actorId,
    ...(r.tax_year ? { periodYear: r.tax_year } : {}),
    ...(type?.draftNeverVisible ? { filingStatus: (visible ? "filed" : "draft") as "filed" | "draft" } : {}),
  })
  if (w.status !== "created" && w.status !== "versioned" && w.status !== "unchanged") return res("failed", `the new storage refused it (${w.status})`)
  // the backup learns which Drive file this is (so it never writes a second copy into Drive)
  const { error: refErr } = await d.rpc("store_import_record_ref", { p_file_id: w.fileId, p_drive_file_id: e.driveFileId, p_sha256: createHash("sha256").update(bytes).digest("hex"), p_drive_path: { area: "import", path: [] } })
  const refNote = refErr ? ` (the backup could not record the Drive original: ${refErr.message})` : ""

  // the client sees exactly what they saw
  let keep: string | null = null
  if (visible && !type) keep = "the client can see this but it has no type — its CRM record still opens from Drive until it gets one (Needs a type)"
  else if (visible && type?.staffOnly) keep = "the client can see this but its type is staff-only in the new storage — its CRM record still opens from Drive; check it"
  else if (visible) {
    const { error } = await d.rpc("store_set_published", { p_file_id: w.fileId, p_published: true, p_actor: ctx.actorId })
    if (error) keep = `the client can see this but the new storage refused to show it (${error.message.replace(/^store: /, "")}) — its CRM record still opens from Drive; check it`
  }
  if (keep) return res("kept_on_drive", `${keep}; its bytes are stored hidden${refNote}`)

  // ledger FIRST (the old pointer), then exactly this record
  const { storePointer, storeDocumentLink } = await import("./document-pointer")
  const entry: LedgerEntry = { id: r.id, drive_file_id: r.drive_file_id, drive_link: r.drive_link ?? null }
  const { data: item, error: iErr } = await d.from("store_import_items").insert({ run_id: ctx.runId, source: "drive", source_id: `catch-up-row:${r.id}`, drive_path: [], name, mime_type: mime ?? null, size_bytes: bytes.length, source_md5: sum.md5, status: "done", store_file_id: w.fileId, repointed: [entry] }).select("id").maybeSingle()
  if (iErr || !item) return res("failed", `could not record the record in the ledger (${iErr?.message ?? "no row"}) — nothing was changed`)
  const { data: changed, error: uErr } = await d.from("documents").update({ drive_file_id: storePointer(w.fileId), drive_link: storeDocumentLink(r.id), updated_at: new Date().toISOString() }).eq("id", r.id).eq("drive_file_id", r.drive_file_id).select("id")
  if (uErr || !changed || changed.length !== 1) {
    await d.from("store_import_items").delete().eq("id", item.id)
    return res("failed", `the record could not be re-pointed (${uErr?.message ?? "it changed while the catch-up ran"})`)
  }
  // the proof from the storage itself — a mismatch puts the record straight back
  try {
    const { readStoreFile } = await import("./document-pointer")
    const stored = await readStoreFile(w.fileId)
    const ok = sum.md5 ? md5Hex(stored.bytes) === sum.md5 : stored.bytes.length === bytes.length
    if (!ok) throw new Error("the stored bytes do not match Drive's")
  } catch (err) {
    await restoreEntries([entry])
    await d.rpc("store_set_published", { p_file_id: w.fileId, p_published: false, p_actor: ctx.actorId })
    return res("put_back", `${err instanceof Error ? err.message : String(err)} — the record was put back on Drive`)
  }
  return res("brought_in", `ok${refNote}`)
}

export async function runCatchUp(accountId: string, actorId: string | null, opts: { expectedPlanHash?: string } = {}): Promise<CatchUpResult> {
  const { goLiveAllowed } = await import("./go-live")
  if (!goLiveAllowed()) throw new Error("Catch-up is switched off in this environment.")
  if (!actorId) throw new Error("Only a signed-in owner can run a catch-up.")
  const d = db()
  await sweepStaleCatchUpRuns() // a catch-up that died must not keep a company's lock

  const plan = await planCatchUp(accountId)
  if (plan.blockers.length) return { ok: false, message: plan.blockers.join(" "), runId: null, items: [], plan }
  if (opts.expectedPlanHash && opts.expectedPlanHash !== plan.planHash) return { ok: false, message: "The company changed since the preview you looked at — run the preview again.", runId: null, items: [], plan }
  if (!plan.eligible.length) return { ok: true, message: "Nothing to catch up.", runId: null, items: [], plan }

  // THE LOCK: the database allows ONE open run per company. Tagged catchUp, NEVER goLive.
  const { data: run, error: rErr } = await d.from("store_import_runs").insert({ account_id: accountId, owner_id: plan.ownerId, status: "moving", mode: "move", started_by: actorId, report: { catchUp: true } }).select("id").maybeSingle()
  if (rErr || !run) {
    const dup = (rErr as { code?: string } | null)?.code === "23505"
    return { ok: false, message: dup ? "Another move, switch or catch-up is already open for this company." : `The catch-up could not start (${rErr?.message ?? "no answer"}).`, runId: null, items: [], plan }
  }
  const runId = run.id as string
  const items: CatchUpItemResult[] = []
  const close = async (status: "done" | "incomplete" | "failed", message: string) => {
    await d.from("store_import_runs").update({ status, finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { catchUp: true, message, items } }).eq("id", runId)
  }
  try {
    // re-read the plan UNDER the lock: nothing may have changed between the preview and now
    const again = await planCatchUp(accountId).catch(() => null)
    const before = plan.planHash
    // (the open-run blocker is this run itself — compare only the records)
    const hashNow = again ? sha1(JSON.stringify({ accountId, copyStartedAt: again.copyStartedAt, ids: again.eligible.map((x) => `${x.id}:${x.driveFileId}`) })) : ""
    if (hashNow !== before) { await close("failed", "the company changed while the catch-up was starting — nothing was done"); return { ok: false, message: "The company changed while the catch-up was starting — nothing was done. Run the preview again.", runId, items, plan } }

    const types = await loadTypes()
    const folders = await must<Array<{ id: string; kind: string; parent_id: string | null }>>(d.from("store_folders").select("id, kind, parent_id").eq("owner_id", plan.ownerId).is("trashed_at", null), "the company's folders")
    const folderByKind = new Map<string, string>()
    for (const f of folders) if (f.parent_id && !folderByKind.has(f.kind)) folderByKind.set(f.kind, f.id)
    const ctx: RunCtx = { runId, accountId, ownerId: plan.ownerId as string, actorId, types, folderByKind }
    const deadline = Date.now() + CATCH_UP_BUDGET_MS
    for (const e of plan.eligible) {
      if (Date.now() + MIN_TIME_PER_FILE_MS > deadline) { items.push({ id: e.id, name: e.name, outcome: "failed", detail: "not reached — out of time; run it again" }); continue }
      await d.from("store_import_runs").update({ updated_at: new Date().toISOString() }).eq("id", runId).eq("status", "moving")
      try { items.push(await catchUpOne(e, ctx)) } catch (err) { items.push({ id: e.id, name: e.name, outcome: "failed", detail: err instanceof Error ? err.message : String(err) }) }
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await close("failed", why)
    return { ok: false, message: `The catch-up stopped: ${why}`, runId, items, plan }
  }
  const bad = items.filter((i) => i.outcome === "failed" || i.outcome === "put_back").length
  const message = `${items.filter((i) => i.outcome === "brought_in").length} brought in, ${items.filter((i) => i.outcome === "kept_on_drive").length} kept on Drive (listed), ${bad} not done (listed).`
  await close(bad ? "incomplete" : "done", message)
  return { ok: bad === 0, message, runId, items, plan }
}

async function restoreEntries(entries: LedgerEntry[]): Promise<{ restored: number; problems: string[] }> {
  const d = db()
  let restored = 0
  const problems: string[] = []
  for (const r of entries) {
    if (r.created) {
      const { error } = await d.from("documents").delete().eq("id", r.id).like("drive_file_id", "store:%")
      if (error) problems.push(`the record ${r.id} the catch-up created could not be removed (${error.message})`)
      else restored += 1
      continue
    }
    const patch = { ...(r.before ?? {}), drive_file_id: r.drive_file_id, drive_link: r.drive_link }
    const { error, count } = await d.from("documents").update(patch, { count: "exact" }).eq("id", r.id).like("drive_file_id", "store:%") // only a record that still points at the storage
    if (error) problems.push(`record ${r.id} could not be put back (${error.message})`)
    else restored += count ?? 0
  }
  return { restored, problems }
}

/** Undo a catch-up: every record goes back to its Drive file; the company stays switched. A stored copy is hidden again ONLY when its record was restored. */
export async function undoCatchUp(runId: string, actorId: string | null): Promise<{ restored: number; problems: string[] }> {
  if (!actorId) throw new Error("Only a signed-in owner can undo a catch-up.")
  const d = db()
  const { data: run, error } = await d.from("store_import_runs").select("id, status, mode, report").eq("id", runId).maybeSingle()
  if (error || !run) throw new Error("Catch-up not found.")
  const rep = (run.report ?? {}) as { catchUp?: boolean; goLive?: boolean }
  if (run.mode !== "move" || rep.catchUp !== true || rep.goLive === true) throw new Error("That is not a catch-up, so it cannot be undone here.")
  if (run.status === "rolled_back") return { restored: 0, problems: [] }
  if (run.status === "moving") throw new Error("This catch-up is still running — wait for it to finish (or for the stuck-run sweep), then undo.")
  const lock = await d.from("store_import_runs").update({ status: "undoing", updated_at: new Date().toISOString() }).eq("id", runId).in("status", ["done", "incomplete", "failed"]).select("id")
  if (lock.error || !(lock.data ?? []).length) throw new Error("The undo could not start (the catch-up changed state).")
  const items = await readAll<{ repointed: LedgerEntry[] | null; store_file_id: string | null }>((from, to) => d.from("store_import_items").select("repointed, store_file_id").eq("run_id", runId).order("id").range(from, to), "the ledger")
  let restored = 0
  const problems: string[] = []
  for (const it of items) {
    const r = await restoreEntries(it.repointed ?? [])
    restored += r.restored
    problems.push(...r.problems)
    if (it.store_file_id && r.problems.length === 0) await d.rpc("store_set_published", { p_file_id: it.store_file_id, p_published: false, p_actor: actorId })
  }
  await d.from("store_import_runs").update({ status: "rolled_back", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { catchUp: true, undone: true, problems } }).eq("id", runId)
  return { restored, problems }
}

/** A catch-up that stopped answering (a killed request) must not keep the company's lock: close it. Its finished files stay finished. */
export async function sweepStaleCatchUpRuns(): Promise<{ swept: number }> {
  const d = db()
  const cutoff = new Date(Date.now() - CATCH_UP_STALE_MINUTES * 60_000).toISOString()
  const { data } = await d.from("store_import_runs").select("id").eq("mode", "move").eq("status", "moving").lt("updated_at", cutoff).filter("report->>catchUp", "eq", "true")
  let swept = 0
  for (const r of (data ?? []) as Array<{ id: string }>) {
    const u = await d.from("store_import_runs").update({ status: "incomplete", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { catchUp: true, message: "stopped answering; closed by the sweep" } }).eq("id", r.id).eq("status", "moving").select("id")
    if (!u.error && (u.data ?? []).length) swept += 1
  }
  return { swept }
}
