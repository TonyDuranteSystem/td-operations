/**
 * CRM Store — go live for ONE company: the database part (master plan Part 33, dev job ad09ea91) — CLEAN LISTING.
 * The decisions are pure and live in ./go-live.ts; this file takes the lock, reads the facts, writes the ledger and the
 * records, proves the stored files are the approved bytes with one record each, and flips the company.
 *
 * Order matters (council review 2026-10-13): LOCK FIRST, then read the facts and decide — so nothing can change between the
 * decision and the change. Every failure before the flip undoes everything. A company that runs out of time is undone too.
 */

import {
  buildGoLiveReport, filesWithoutRecord, goLiveAllowed, goLiveBlockers, isExcludedCompany, mapRows, planFingerprint, storeDocumentLink, storePointer,
  type CrmDocRow, type GoLiveReport, type LedgerFile, type RowVerdict, type StoredFileInfo,
} from "./go-live"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until production
async function db(): Promise<any> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return supabaseAdmin
}

/** One company gets this long; past it the switch is undone (a request the platform kills cannot clean up after itself). */
export const COMPANY_BUDGET_MS = 200_000
/** A go-live run with no sign of life for this long is dead: the sweeper undoes it. */
export const STALE_GO_LIVE_MINUTES = 30
const CHUNK = 100

/** Pure: split a long list (a long `.in()` list breaks the request). */
export function chunksOf<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Read EVERY row (the database returns at most 1000 per request). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function selectAll<T>(build: (from: number, to: number) => any, what: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999)
    if (error) throw new Error(`Could not read ${what} (${error.message}) — nothing was changed.`)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < 1000) break
  }
  return out
}

/** Read rows whose column is in a long list, in chunks. */
async function selectIn<T>(list: string[], build: (part: string[]) => Promise<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = []
  for (const part of chunksOf(list)) {
    const { data, error } = await build(part)
    if (error) throw new Error(`Could not read ${what} (${error.message}) — nothing was changed.`)
    out.push(...(data ?? []))
  }
  return out
}

interface Facts {
  accountId: string
  companyName: string
  excluded: boolean
  owners: Array<{ id: string; study_only: boolean }>
  doneCopyRunIds: string[]
  /** when the latest approved copy started: records the CRM made after this are new work, left as they are */
  copyStartedAt: string | null
  openMoveRun: boolean
  openSigning: boolean
  state: "drive" | "moving" | "store"
  ledger: LedgerFile[]
  rows: CrmDocRow[]
  stored: StoredFileInfo[]
}

/** `ownLockRunId`: the go-live run that IS the lock — its own open run must not count as "a move is already open". */
async function loadFacts(accountId: string, ownLockRunId: string | null = null): Promise<Facts> {
  const d = await db()
  const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`Could not read ${what} (${r.error.message}) — nothing was changed.`)
    return (r.data ?? ([] as unknown)) as T
  }
  const { data: acct, error: aErr } = await d.from("accounts").select("id, company_name, status").eq("id", accountId).maybeSingle()
  if (aErr || !acct) throw new Error("Company not found.")
  const owners = must(await d.from("store_owners").select("id, study_only").eq("account_id", accountId).eq("kind", "company"), "the company's storage") as Array<{ id: string; study_only: boolean }>
  const ownerIds = owners.map((o) => o.id)
  const copyRuns = ownerIds.length
    ? (must(await d.from("store_import_runs").select("id, started_at").in("owner_id", ownerIds).eq("mode", "copy").eq("status", "done").order("started_at", { ascending: false }), "the copy runs") as Array<{ id: string; started_at: string }>)
    : []
  const openRunsAll = must(await d.from("store_import_runs").select("id").eq("account_id", accountId).eq("mode", "move").in("status", ["scanning", "moving", "undoing"]), "open moves") as Array<{ id: string }>
  const openRuns = openRunsAll.filter((r) => r.id !== ownLockRunId)
  const { stateFrom, companyDocState } = await import("./switched-drive-guard")
  // holding our own lock: the state ignores it (a live storage means "store"; any OTHER open run means "moving")
  const state = ownLockRunId ? stateFrom({ hasLiveOwner: owners.some((o) => !o.study_only), openMoveRun: openRuns.length > 0 }) : await companyDocState(accountId)

  // An open E-SIGN envelope no longer blocks the switch: when it is signed, the signed PDF is filed through companyDocState() into the company's NEW storage (lib/operations/esign.ts), never Drive.
  // SS-4s and signature requests still block (their filing paths were not checked for this).
  const openSs4 = must(await d.from("ss4_applications").select("id").eq("account_id", accountId).eq("status", "awaiting_signature").limit(1), "open SS-4s") as unknown[]
  const openSig = must(await d.from("signature_requests").select("id").eq("account_id", accountId).eq("status", "awaiting_signature").limit(1), "open signature requests") as unknown[]

  const ledger: LedgerFile[] = []
  for (const run of copyRuns) {
    const items = await selectAll<{ source_id: string; store_file_id: string; source_md5: string | null; size_bytes: number | null; sha256: string | null }>(
      (from, to) => d.from("store_import_items").select("source_id, store_file_id, source_md5, size_bytes, sha256").eq("run_id", run.id).eq("source", "drive").in("status", ["done", "merged"]).not("store_file_id", "is", null).order("id").range(from, to),
      "the copy ledger")
    for (const i of items) ledger.push({ sourceId: i.source_id, storeFileId: i.store_file_id, md5: i.source_md5, size: i.size_bytes, sha256: i.sha256, runStartedAt: run.started_at })
  }

  const cols = "id, drive_file_id, file_name, mime_type, contact_id, portal_visible, service_delivery_id, flow_stage, created_at"
  const rows: CrmDocRow[] = await selectAll<CrmDocRow>((from, to) => d.from("documents").select(cols).eq("account_id", accountId).order("id").range(from, to), "the company's documents")
  // a member's own records (no company on them) belong to the same move — the same rule the move uses
  const memberIds = (must(await d.from("account_contacts").select("contact_id").eq("account_id", accountId), "the company's people") as Array<{ contact_id: string }>).map((m) => m.contact_id)
  if (memberIds.length) {
    const personRows = await selectAll<CrmDocRow>((from, to) => d.from("documents").select(cols).is("account_id", null).in("contact_id", memberIds.slice(0, 200)).order("id").range(from, to), "the people's documents")
    const have = new Set(rows.map((r) => r.id))
    for (const pr of personRows) if (!have.has(pr.id)) rows.push(pr)
  }

  const stored = await loadStoredFiles(d, ledger, ownerIds)
  return {
    accountId, companyName: acct.company_name as string, excluded: isExcludedCompany({ id: accountId, status: (acct.status as string | null) ?? null, name: acct.company_name as string }),
    owners, doneCopyRunIds: copyRuns.map((r) => r.id), copyStartedAt: copyRuns[0]?.started_at ?? null, openMoveRun: openRuns.length > 0,
    openSigning: openSs4.length + openSig.length > 0, state, ledger, rows, stored,
  }
}

/** The live stored files that must each have ONE record: what the approved copy stored (company AND people) plus the company's own live files. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadStoredFiles(d: any, ledger: LedgerFile[], companyOwnerIds: string[]): Promise<StoredFileInfo[]> {
  const ids = new Set(ledger.map((l) => l.storeFileId))
  if (companyOwnerIds.length) {
    const own = await selectAll<{ id: string }>((from, to) => d.from("store_files").select("id").in("owner_id", companyOwnerIds).eq("state", "live").order("id").range(from, to), "the company's stored files")
    for (const f of own) ids.add(f.id)
  }
  if (ids.size === 0) return []
  type F = { id: string; owner_id: string; name: string; document_type: string | null; period_year: number | null; folder_id: string | null; state: string; store_file_versions: { size_bytes: number | null; mime_type: string | null } | null }
  const files = await selectIn<F>(Array.from(ids), (part) => d.from("store_files").select("id, owner_id, name, document_type, period_year, folder_id, state, store_file_versions!store_files_current_version_fk(size_bytes, mime_type)").in("id", part), "the stored files")
  const live = files.filter((f) => f.state === "live")
  const ownerRows = await selectIn<{ id: string; kind: string; contact_id: string | null }>(Array.from(new Set(live.map((f) => f.owner_id))), (part) => d.from("store_owners").select("id, kind, contact_id").in("id", part), "the storages")
  const ownerOf = new Map(ownerRows.map((o) => [o.id, o]))
  const { data: cat, error: cErr } = await d.from("catalog_entries").select("slug, display_name, metadata").eq("catalog_id", "storage_document_types")
  if (cErr) throw new Error(`Could not read the document types (${cErr.message}) — nothing was changed.`)
  const typeOf = new Map(((cat ?? []) as Array<{ slug: string; display_name: string; metadata: { legacy_document_type_id?: number } | null }>).map((t) => [t.slug, t]))
  const { categoryForFolder } = await import("./structure")
  const folderCat = new Map<string, { num: number; name: string }>()
  const out: StoredFileInfo[] = []
  for (const f of live) {
    let c: { num: number; name: string } | null = null
    if (f.folder_id) {
      if (!folderCat.has(f.folder_id)) { try { folderCat.set(f.folder_id, await categoryForFolder(f.folder_id)) } catch { /* no category: the record is listed without one */ } }
      c = folderCat.get(f.folder_id) ?? null
    }
    const t = f.document_type ? typeOf.get(f.document_type) : undefined
    const o = ownerOf.get(f.owner_id)
    out.push({
      id: f.id, name: f.name, typeSlug: f.document_type, typeDisplay: t?.display_name ?? null,
      legacyTypeId: typeof t?.metadata?.legacy_document_type_id === "number" ? t.metadata.legacy_document_type_id : null,
      periodYear: f.period_year, ownerKind: o?.kind ?? "company", ownerContactId: o?.kind === "person" ? o.contact_id : null,
      categoryNum: c?.num ?? null, categoryName: c?.name ?? null, mimeType: f.store_file_versions?.mime_type ?? null, sizeBytes: f.store_file_versions?.size_bytes ?? null,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A workspace document (it has a stage or a service delivery) is shown to the client BY ITS STAGE, whatever the visible flag says. If the
 * stored file behind it is not open to clients yet (no type, a staff-only type, or someone's personal file filed under the company),
 * re-pointing it would break what the client sees. So that one old record stays exactly as it is (still opens from Drive) and the stored
 * file gets its own new, hidden record — the company still switches.
 */
async function keepStageDocsThatClientCouldNotOpen(verdicts: RowVerdict[], f: Facts): Promise<RowVerdict[]> {
  const byId = new Map(f.rows.map((r) => [r.id, r]))
  const stage = verdicts.filter((v) => v.action === "repoint" && v.storeFileId && (() => { const r = byId.get(v.rowId); return !!(r && (r.flow_stage || r.service_delivery_id)) })())
  if (stage.length === 0) return verdicts
  const { staffOnlyStorePointers, personalStoreFilesOutsidePerson } = await import("./document-pointer")
  const closed = new Set<string>()
  const personal = new Set<string>()
  for (const part of chunksOf(stage.map((v) => storePointer(v.storeFileId as string)), 50)) {
    Array.from(await staffOnlyStorePointers(part)).forEach((p) => closed.add(p))
    Array.from(await personalStoreFilesOutsidePerson(part)).forEach((p) => personal.add(p))
  }
  return verdicts.map((v) => {
    if (v.action !== "repoint" || !v.storeFileId) return v
    const r = byId.get(v.rowId)
    if (!r || !(r.flow_stage || r.service_delivery_id)) return v
    const p = storePointer(v.storeFileId)
    if (!closed.has(p) && !personal.has(p)) return v
    return { ...v, action: "leave" as const, storeFileId: null, reason: "a workspace document the client sees by its stage — its stored file is not open to clients yet (no type), so this record stays as it is" }
  })
}

interface Plan { blockers: string[]; verdicts: RowVerdict[]; newRecords: StoredFileInfo[]; report: GoLiveReport }

async function plan(f: Facts): Promise<Plan> {
  const blockers = goLiveBlockers({
    excluded: f.excluded, ownerCount: f.owners.length, ownerIsStudy: f.owners.length === 1 && f.owners[0].study_only,
    hasDoneCopy: f.doneCopyRunIds.length > 0, openMoveRun: f.openMoveRun, openSigning: f.openSigning, state: f.state,
  })
  let verdicts = mapRows(f.rows, f.ledger, f.copyStartedAt)
  const taken = new Set<string>()
  if (!blockers.length) {
    // the database allows ONE record per stored file: a file another record (another company's, for a person in two companies)
    // already lists needs no new record, and this company's old record of it is archived instead of re-pointed
    const d = await db()
    const pointers = f.stored.map((s) => storePointer(s.id))
    const used = await selectIn<{ id: string; drive_file_id: string }>(pointers, (part) => d.from("documents").select("id, drive_file_id").in("drive_file_id", part), "which stored files already have a record")
    const own = new Set(f.rows.map((r) => r.id))
    for (const u of used) if (!own.has(u.id)) taken.add(u.drive_file_id)
    verdicts = verdicts.map((v) => (v.action === "repoint" && v.storeFileId && taken.has(storePointer(v.storeFileId)) ? { ...v, action: "archive" as const, reason: "another record already lists this stored file — archived" } : v))
    // a record whose stored copy was removed from storage after the copy (staff trashed it) cannot be re-pointed: it stays as it is
    const liveIds = new Set(f.stored.map((x) => x.id))
    verdicts = verdicts.map((v) => (v.action === "repoint" && v.storeFileId && !liveIds.has(v.storeFileId) ? { ...v, action: "leave" as const, storeFileId: null, reason: "its stored copy is no longer in storage (it was removed after the copy) — this record stays as it is" } : v))
    verdicts = await keepStageDocsThatClientCouldNotOpen(verdicts, f)
  }
  const newRecords = blockers.length ? [] : filesWithoutRecord(f.stored, verdicts, taken)
  const report = buildGoLiveReport(f.accountId, blockers, f.rows, verdicts, f.stored, newRecords)
  report.planHash = planFingerprint(verdicts, newRecords)
  return { blockers, verdicts, newRecords, report }
}

/** DRY RUN — reads only. What the CRM list under this company would become if it went live now. */
export async function planGoLive(accountId: string): Promise<GoLiveReport> {
  return (await plan(await loadFacts(accountId))).report
}

export interface GoLiveResult { ok: boolean; runId: string | null; message: string; report: GoLiveReport | null; repointed: number; problems: string[] }

function emptyResult(message: string): GoLiveResult { return { ok: false, runId: null, message, report: null, repointed: 0, problems: [] } }

/** The fields of a record the switch may change — saved before, put back by undo. */
const BEFORE_COLS = "file_name, mime_type, file_size, document_type_id, document_type_name, category, category_name, tax_year, portal_visible, status, drive_link, updated_at"

export async function runGoLive(accountId: string, actorId: string | null, opts: { expectedPlanHash?: string } = {}): Promise<GoLiveResult> {
  if (!goLiveAllowed()) throw new Error("Going live is switched off in this environment.")
  if (!actorId) throw new Error("Only a signed-in owner can switch a company.")
  const d = await db()
  const deadline = Date.now() + COMPANY_BUDGET_MS

  // 1) THE LOCK FIRST (the database allows ONE open run per company, so a second request fails right here) —
  //    then the facts are read and the decision is made, so nothing can change in between
  const { data: run, error: rErr } = await d.from("store_import_runs").insert({ account_id: accountId, owner_id: null, status: "moving", mode: "move", started_by: actorId, report: { goLive: true } }).select("id").maybeSingle()
  if (rErr || !run) {
    const dup = (rErr as { code?: string } | null)?.code === "23505"
    return emptyResult(dup ? "Another switch or move is already open for this company." : `The switch could not start (${rErr?.message ?? "no answer"}).`)
  }
  const runId = run.id as string
  const release = async (why: string) => { await d.from("store_import_runs").update({ status: "failed", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { goLive: true, notStarted: why } }).eq("id", runId).eq("status", "moving") }

  let f: Facts
  let pl: Plan
  try {
    f = await loadFacts(accountId, runId)
    pl = await plan(f)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    await release(why)
    return emptyResult(`Nothing was switched: ${why}`)
  }
  const { blockers, verdicts, newRecords, report } = pl
  if (blockers.length) { await release(blockers.join(" ")); return { ...emptyResult(blockers.join(" ")), report } }
  if (opts.expectedPlanHash && opts.expectedPlanHash !== report.planHash) {
    await release("the plan changed since the preview")
    return { ...emptyResult("The company changed since the preview you looked at — run the preview again, then switch."), report }
  }

  const owner = f.owners[0]
  await d.from("store_import_runs").update({ owner_id: owner.id, updated_at: new Date().toISOString() }).eq("id", runId)

  const storedById = new Map(f.stored.map((s) => [s.id, s]))
  const problems: string[] = []
  const beat = async () => {
    if (Date.now() > deadline) throw new Error("this company took too long")
    await d.from("store_import_runs").update({ updated_at: new Date().toISOString() }).eq("id", runId).eq("status", "moving")
  }
  const ledgerInsert = async (name: string, sourceKey: string, storeFileId: string | null, why: string, entry: Record<string, unknown>) => {
    const { error } = await d.from("store_import_items").insert({ run_id: runId, source: "drive", source_id: sourceKey, name, status: "done", reason: why, store_file_id: storeFileId, repointed: [entry] })
    if (error) throw new Error(`could not record "${name}" in the ledger (${error.message})`)
  }
  try {
    // 2) the records of the stored files: an old record of the same file is reused (re-pointed and relabelled, hidden); old records
    //    the cleaning did not keep are archived. Ledger first (with every old value), then the change.
    let n = 0
    for (const v of verdicts.filter((x) => x.action === "repoint" || x.action === "archive")) {
      if (n++ % 10 === 0) await beat()
      const { data: cur, error: cErr } = await d.from("documents").select(`id, drive_file_id, ${BEFORE_COLS}`).eq("id", v.rowId).maybeSingle()
      if (cErr || !cur) throw new Error(`could not read a record (${cErr?.message ?? "not found"})`)
      const before: Record<string, unknown> = {}
      for (const k of BEFORE_COLS.split(", ")) before[k] = (cur as Record<string, unknown>)[k] ?? null
      const label = (cur.file_name as string | null) ?? "document"
      if (v.action === "archive") {
        await ledgerInsert(label, `go-live-row:${v.rowId}`, null, "go-live archive", { id: v.rowId, drive_file_id: cur.drive_file_id, drive_link: cur.drive_link ?? null, archived: true, before })
        const { data: ch, error: uErr } = await d.from("documents").update({ status: "archived", portal_visible: false, updated_at: new Date().toISOString() }).eq("id", v.rowId).eq("drive_file_id", cur.drive_file_id).select("id")
        if (uErr || !ch || ch.length !== 1) throw new Error(`could not archive "${label}" (${uErr?.message ?? "it changed while the switch was running"})`)
        continue
      }
      const s = storedById.get(v.storeFileId as string)
      if (!s) throw new Error(`the stored file of "${label}" is not live any more`)
      await ledgerInsert(label, `go-live-row:${v.rowId}`, s.id, "go-live link", { id: v.rowId, drive_file_id: cur.drive_file_id, drive_link: cur.drive_link ?? null, before })
      const { data: ch, error: uErr } = await d.from("documents").update({
        drive_file_id: storePointer(s.id), drive_link: storeDocumentLink(v.rowId),
        file_name: s.name, mime_type: s.mimeType, file_size: s.sizeBytes,
        document_type_id: s.legacyTypeId, document_type_name: s.typeDisplay, category: s.categoryNum, category_name: s.categoryName, tax_year: s.periodYear,
        portal_visible: false, status: "classified", updated_at: new Date().toISOString(),
      }).eq("id", v.rowId).eq("drive_file_id", cur.drive_file_id).select("id")
      if (uErr || !ch || ch.length !== 1) throw new Error(`could not re-point "${label}" (${uErr?.message ?? "it changed while the switch was running"})`)
    }

    // 3) a stored file with no old record gets a NEW record (hidden), carrying the storage's clean name / type / year
    const { upsertStoreDocumentRow } = await import("./formation-pilot")
    for (const s of newRecords) {
      if (n++ % 10 === 0) await beat()
      const r = await upsertStoreDocumentRow(s.id, {
        file_name: s.name, mime_type: s.mimeType, file_size: s.sizeBytes, document_type_name: s.typeDisplay, category: s.categoryNum, category_name: s.categoryName,
        status: "classified", account_id: accountId, contact_id: s.ownerContactId, portal_visible: false,
      })
      if (!r.inserted) continue // another record already lists it (a person in two companies)
      try {
        await d.from("documents").update({ document_type_id: s.legacyTypeId, tax_year: s.periodYear }).eq("id", r.id)
        await ledgerInsert(s.name, `go-live-new:${s.id}`, s.id, "go-live new record", { id: r.id, drive_file_id: storePointer(s.id), drive_link: null, created: true })
      } catch (e) {
        await d.from("documents").delete().eq("id", r.id).like("drive_file_id", "store:%") // never leave a record the ledger does not know
        throw e
      }
    }

    // 4) prove it: every stored file is the approved bytes and has exactly ONE record now; a workspace document the client sees by
    //    its stage still opens
    await beat()
    const { readStoreVersionFacts } = await import("./go-live-verify")
    const pointers = f.stored.map((s) => storePointer(s.id))
    const listed = await selectIn<{ id: string; drive_file_id: string }>(pointers, (part) => d.from("documents").select("id, drive_file_id").in("drive_file_id", part), "the records to check")
    const countOf = new Map<string, number>()
    for (const r of listed) countOf.set(r.drive_file_id, (countOf.get(r.drive_file_id) ?? 0) + 1)
    for (const s of f.stored) {
      const c = countOf.get(storePointer(s.id)) ?? 0
      if (c !== 1) problems.push(`"${s.name}": ${c} records list it (it must be exactly one)`)
      const have = await readStoreVersionFacts(s.id)
      const want = f.ledger.find((l) => l.storeFileId === s.id)
      if (!have) problems.push(`"${s.name}": the stored file is missing`)
      else if (want?.sha256 && have.sha256) {
        // the exact fingerprint decides (a merged document — a signing certificate folded in — is rightly bigger than the Drive original the
        // copy recorded the size of); the size is only the fallback when no fingerprint was recorded
        if (have.sha256 !== want.sha256) problems.push(`"${s.name}": the stored copy is not the bytes that were approved`)
      } else if (want?.size != null && have.size !== want.size) problems.push(`"${s.name}": the stored copy is ${have.size} bytes, the original was ${want.size}`)
    }
    const stageRows = verdicts.filter((x) => x.action === "repoint").map((x) => x.rowId)
    if (stageRows.length) {
      // only the STORED FILE is checked here (typed, not staff-only, not someone's personal file): whether the client is shown the workspace
      // document at all is decided by its stage, and an internal document (an IRS fax confirmation …) is rightly not shown — that is not a defect
      const { dropStoreRowsClientCannotOpen } = await import("@/lib/portal/client-store-docs")
      const nowRows = await selectIn<{ id: string; drive_file_id: string; file_name: string | null; portal_visible: boolean | null; service_delivery_id: string | null; flow_stage: string | null }>(stageRows, (part) => d.from("documents").select("id, drive_file_id, file_name, portal_visible, service_delivery_id, flow_stage").in("id", part).not("flow_stage", "is", null), "the workspace records to check")
      const openable = new Set((await dropStoreRowsClientCannotOpen(nowRows, { applyRowRule: false })).map((r) => r.id))
      for (const r of nowRows) if (!openable.has(r.id)) problems.push(`"${r.file_name}": a workspace document's stored file is not open to clients`)
    }
    if (problems.length) throw new Error(`the check found differences: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`)

    // 5) the company's people: a person's storage goes live once EVERY company they belong to is in the new storage.
    //    The ids are written to the run BEFORE they are flipped, so an undo always knows them.
    const { data: memberRows } = await d.from("account_contacts").select("contact_id").eq("account_id", accountId)
    const personCandidates: string[] = []
    for (const m of (memberRows ?? []) as Array<{ contact_id: string }>) {
      const { data: po } = await d.from("store_owners").select("id, study_only").eq("kind", "person").eq("contact_id", m.contact_id).maybeSingle()
      if (!po || po.study_only !== true) continue
      const { data: links } = await d.from("account_contacts").select("account_id").eq("contact_id", m.contact_id)
      let all = true
      for (const l of (links ?? []) as Array<{ account_id: string }>) {
        if (l.account_id === accountId) continue // this company is about to be live
        const { companyDocState } = await import("./switched-drive-guard")
        if ((await companyDocState(l.account_id)) !== "store") { all = false; break }
      }
      if (all) personCandidates.push(po.id as string)
    }
    {
      const { error } = await d.from("store_import_runs").update({ report: { goLive: true, personOwnersFlipped: personCandidates } }).eq("id", runId).eq("status", "moving")
      if (error) throw new Error(`could not record the people's storages (${error.message})`)
    }

    // 6) flip — only now
    const { data: flipped, error: fErr } = await d.from("store_owners").update({ study_only: false }).eq("id", owner.id).eq("study_only", true).select("id")
    if (fErr || !flipped || flipped.length !== 1) throw new Error(`the company could not be switched (${fErr?.message ?? "it changed meanwhile"})`)
    if (personCandidates.length) {
      const { error: pErr } = await d.from("store_owners").update({ study_only: false }).in("id", personCandidates).eq("study_only", true)
      if (pErr) throw new Error(`a person's storage could not be switched (${pErr.message})`)
    }
    const summary = { storedFiles: f.stored.length, reused: report.listing.reusedRecords, created: newRecords.length, archived: report.listing.archivedRecords }
    const { data: closed, error: eErr } = await d.from("store_import_runs").update({
      status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      report: { goLive: true, ...summary, personOwnersFlipped: personCandidates, studyWas: true },
    }).eq("id", runId).eq("status", "moving").select("id")
    if (eErr || !closed || closed.length !== 1) throw new Error(`the switch could not be closed (${eErr?.message ?? "it was changed meanwhile"})`)
    const { error: bErr } = await d.rpc("store_backup_mark_switched", { p_owner_id: owner.id })
    if (bErr) problems.push(`(the backup window could not be started: ${bErr.message})`)
    return {
      ok: true, runId, report, problems,
      message: `${f.companyName} is now in the new storage: ${f.stored.length} stored files listed (${summary.reused} existing records reused and relabelled, ${summary.created} new), ${summary.archived} old records archived. Nothing is shown to the client until you decide.`,
      repointed: f.stored.length,
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    let undoNotes: string[] = []
    try { undoNotes = (await undoGoLive(runId, actorId, { reason: why, internal: true })).problems } catch (u) { undoNotes = [`the automatic undo itself failed: ${u instanceof Error ? u.message : String(u)} — it will be retried by the sweeper`] }
    return { ok: false, runId, report, repointed: 0, message: `Nothing was switched: ${why}.${undoNotes.length ? ` (Undo notes: ${undoNotes.join("; ")})` : ""}`, problems: [...problems, ...undoNotes] }
  }
}

interface LedgerEntry { id: string; drive_file_id: string; drive_link: string | null; created?: boolean; archived?: boolean; before?: Record<string, unknown> }

/**
 * Undo a go-live: every record, label, visibility and status put back exactly, the records the switch created deleted, the company back
 * to a hidden study copy. Files in storage are never deleted. Only a go-live run can be undone (never a copy run); an open run only by the
 * switch itself (`internal`) or once it is dead (stale).
 */
export async function undoGoLive(runId: string, actorId: string | null, opts: { reason?: string; internal?: boolean } = {}): Promise<{ restored: number; problems: string[]; filesAddedSince: number }> {
  if (!actorId) throw new Error("Only a signed-in owner can undo a switch.")
  const d = await db()
  const { data: run, error } = await d.from("store_import_runs").select("id, owner_id, status, finished_at, updated_at, mode, report").eq("id", runId).maybeSingle()
  if (error || !run) throw new Error("Switch not found.")
  if (run.mode !== "move" || (run.report as { goLive?: boolean } | null)?.goLive !== true) throw new Error("That is not a company switch, so it cannot be undone here.")
  if (run.status === "rolled_back" || run.status === "failed") return { restored: 0, problems: [], filesAddedSince: 0 }
  if (run.status === "moving" && !opts.internal) {
    const age = Date.now() - Date.parse(run.updated_at as string)
    if (!(age > STALE_GO_LIVE_MINUTES * 60_000)) throw new Error("This switch is still running — wait for it to finish, then undo.")
  }
  const problems: string[] = []
  const flipLock = await d.from("store_import_runs").update({ status: "undoing", updated_at: new Date().toISOString() }).eq("id", runId).in("status", ["moving", "done", "incomplete", "undoing"]).select("id")
  if (flipLock.error) throw new Error(`the undo could not start (${flipLock.error.message})`)
  const items = await selectAll<{ repointed: LedgerEntry[] }>((from, to) => d.from("store_import_items").select("repointed").eq("run_id", runId).order("id").range(from, to), "the ledger")
  let restored = 0
  for (const it of items) {
    for (const r of it.repointed ?? []) {
      if (r.created) {
        const { error: e } = await d.from("documents").delete().eq("id", r.id).like("drive_file_id", "store:%")
        if (e) problems.push(`the record ${r.id} the switch created could not be removed (${e.message})`)
        else restored += 1
        continue
      }
      const patch = { ...(r.before ?? {}), drive_file_id: r.drive_file_id, drive_link: r.drive_link } // updated_at is in `before`: restored too
      let q = d.from("documents").update(patch, { count: "exact" }).eq("id", r.id)
      if (!r.archived) q = q.like("drive_file_id", "store:%") // a re-pointed record: only if it still points at storage
      const { error: e, count } = await q
      if (e) problems.push(`record ${r.id} could not be put back (${e.message})`)
      else restored += count ?? 0
    }
  }
  let filesAddedSince = 0
  if (run.owner_id) {
    if (run.finished_at) {
      const { count } = await d.from("store_files").select("id", { count: "exact", head: true }).eq("owner_id", run.owner_id).eq("state", "live").gt("created_at", run.finished_at)
      filesAddedSince = count ?? 0
      if (filesAddedSince > 0) problems.push(`${filesAddedSince} file(s) were added to the new storage after the switch — they stay there and are not in Drive`)
    }
    const a = await d.from("store_owners").update({ study_only: true }).eq("id", run.owner_id).eq("study_only", false)
    if (a.error) problems.push(`the company's storage could not be hidden again (${a.error.message})`)
    // the people this switch made live go back — unless another company of theirs is still in the new storage
    const flipped = ((run.report as { personOwnersFlipped?: string[] } | null)?.personOwnersFlipped ?? []).filter(Boolean)
    if (flipped.length) {
      const { companyDocState } = await import("./switched-drive-guard")
      for (const pid of flipped) {
        const { data: po } = await d.from("store_owners").select("contact_id").eq("id", pid).maybeSingle()
        let stillNeeded = false
        if (po?.contact_id) {
          const { data: links } = await d.from("account_contacts").select("account_id").eq("contact_id", po.contact_id)
          for (const l of (links ?? []) as Array<{ account_id: string }>) if ((await companyDocState(l.account_id)) === "store") { stillNeeded = true; break }
        }
        if (!stillNeeded) {
          const p = await d.from("store_owners").update({ study_only: true }).eq("id", pid).eq("study_only", false)
          if (p.error) problems.push(`a person's storage could not be hidden again (${p.error.message})`)
        }
      }
    }
    const b = await d.from("store_backup_state").update({ switched_at: null, updated_at: new Date().toISOString() }).eq("owner_id", run.owner_id)
    if (b.error) problems.push(`the backup window could not be reset (${b.error.message})`)
  }
  const fin = await d.from("store_import_runs").update({ status: "rolled_back", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { goLive: true, undone: true, reason: opts.reason ?? null, problems, personOwnersFlipped: (run.report as { personOwnersFlipped?: string[] } | null)?.personOwnersFlipped ?? [] } }).eq("id", runId)
  if (fin.error) throw new Error(`the undo finished but the run could not be marked (${fin.error.message})`)
  return { restored, problems, filesAddedSince }
}

/** Dead switches (a request the platform killed): undo each one so no company stays locked. Safe to run any time. */
export async function sweepStaleGoLiveRuns(actorId: string): Promise<{ swept: number; problems: string[] }> {
  const d = await db()
  const cutoff = new Date(Date.now() - STALE_GO_LIVE_MINUTES * 60_000).toISOString()
  const { data, error } = await d.from("store_import_runs").select("id").eq("mode", "move").eq("status", "moving").lt("updated_at", cutoff).filter("report->>goLive", "eq", "true")
  if (error) throw new Error(`Could not look for stuck switches (${error.message}).`)
  const problems: string[] = []
  let swept = 0
  for (const r of (data ?? []) as Array<{ id: string }>) {
    try { await undoGoLive(r.id, actorId, { reason: "the switch stopped answering", internal: true }); swept += 1 } catch (e) { problems.push(`${r.id}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  return { swept, problems }
}
