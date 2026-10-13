/**
 * CRM Store — go live for ONE company: the database part (master plan Part 33, dev job ad09ea91).
 * The decisions are pure and live in ./go-live.ts; this file takes the lock, reads the facts, writes the ledger and the
 * records, proves the client can still open everything, and flips the company. See go-live.ts for the steps.
 *
 * Order matters (council review 2026-10-13): LOCK FIRST, then read the facts and decide — so nothing can change between the
 * decision and the change. Every failure before the flip undoes everything. A company that runs out of time is undone too.
 */

import {
  buildGoLiveReport, goLiveAllowed, goLiveBlockers, isExcludedCompany, mapRows, mustStayOnDrive, planFingerprint, storeDocumentLink, storePointer,
  type CrmDocRow, type GoLiveReport, type LedgerFile, type RowVerdict,
} from "./go-live"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until production
async function db(): Promise<any> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return supabaseAdmin
}

const OPEN_ESIGN_NOT = ["completed", "cancelled", "canceled", "declined", "expired", "void", "voided", "draft"]
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
  /** when the latest approved copy started: records the CRM made after this are "recorded after the copy" */
  copyStartedAt: string | null
  openMoveRun: boolean
  openSigning: boolean
  state: "drive" | "moving" | "store"
  ledger: LedgerFile[]
  rows: CrmDocRow[]
  serviceTypes: Map<string, string | null>
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

  const openEsign = must(await d.from("esign_envelopes").select("id").eq("owner_account_id", accountId).not("status", "in", `(${OPEN_ESIGN_NOT.join(",")})`).limit(1), "open signings") as unknown[]
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
  const sdIds = Array.from(new Set(rows.map((r) => r.service_delivery_id).filter((x): x is string => !!x)))
  const serviceTypes = new Map<string, string | null>()
  for (const s of await selectIn<{ id: string; service_type: string | null }>(sdIds, (part) => d.from("service_deliveries").select("id, service_type").in("id", part), "service types")) serviceTypes.set(s.id, s.service_type)

  return {
    accountId, companyName: acct.company_name as string, excluded: isExcludedCompany({ id: accountId, status: (acct.status as string | null) ?? null, name: acct.company_name as string }),
    owners, doneCopyRunIds: copyRuns.map((r) => r.id), copyStartedAt: copyRuns[0]?.started_at ?? null, openMoveRun: openRuns.length > 0,
    openSigning: openEsign.length + openSs4.length + openSig.length > 0, state, ledger, rows, serviceTypes,
  }
}

/** Run `fn` over `list` with a few at a time. */
async function pool<T>(list: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (next < list.length) { const i = next++; await fn(list[i]) }
  }))
}

/** Twin detection: a Drive file NOT in the ledger whose bytes (checksum + size) equal a ledger file's. Read-only Drive calls. */
async function findTwins(f: Facts, deadline: number): Promise<Map<string, LedgerFile>> {
  const inLedger = new Set(f.ledger.map((l) => l.sourceId))
  const byKey = new Map<string, LedgerFile>()
  for (const l of f.ledger) if (l.md5 && l.size != null) byKey.set(`${l.md5}:${l.size}`, l)
  const out = new Map<string, LedgerFile>()
  if (byKey.size === 0) return out
  const { getDriveFileChecksum } = await import("@/lib/google-drive")
  const todo = f.rows.filter((r) => !r.drive_file_id.startsWith("store:") && !r.drive_file_id.startsWith("storage:") && !r.drive_file_id.startsWith("ss4-") && !inLedger.has(r.drive_file_id))
  await pool(todo, 6, async (r) => {
    if (Date.now() > deadline) throw new Error("this company took too long to check")
    try {
      const c = await getDriveFileChecksum(r.drive_file_id)
      if (c.md5 && c.size != null) {
        const hit = byKey.get(`${c.md5}:${c.size}`)
        if (hit) out.set(r.id, hit)
      }
    } catch { /* a dead or unreadable Drive link: no twin — the record stays on Drive and is listed */ }
  })
  return out
}

/** An "exact" match is only trusted if the Drive file is STILL the bytes that were copied (it may have been edited or replaced since). */
async function holdBackChangedSinceCopy(verdicts: RowVerdict[], f: Facts, deadline: number): Promise<RowVerdict[]> {
  const byRow = new Map(f.rows.map((r) => [r.id, r]))
  const ledgerOf = (storeFileId: string, driveId: string) => f.ledger.find((l) => l.storeFileId === storeFileId && l.sourceId === driveId) ?? null
  const check = verdicts.filter((v) => v.action === "repoint" && v.via === "exact" && v.storeFileId)
  const changed = new Map<string, { action: "catchup" | "leave"; reason: string }>()
  const { getDriveFileChecksum } = await import("@/lib/google-drive")
  await pool(check, 6, async (v) => {
    if (Date.now() > deadline) throw new Error("this company took too long to check")
    const row = byRow.get(v.rowId) as CrmDocRow
    if (row.drive_file_id.startsWith("ss4-")) return
    const want = ledgerOf(v.storeFileId as string, row.drive_file_id)
    if (!want || !want.md5) return // no fingerprint recorded at copy time (e.g. a Google Doc): nothing to compare
    try {
      const c = await getDriveFileChecksum(row.drive_file_id)
      if (c.md5 && (c.md5 !== want.md5 || (want.size != null && c.size != null && c.size !== want.size))) changed.set(v.rowId, { action: "catchup", reason: "the file was changed in Drive after it was copied — the current version is brought in" })
    } catch { changed.set(v.rowId, { action: "leave", reason: "the Drive file could not be read to confirm it is unchanged — stays on Drive" }) }
  })
  return verdicts.map((v) => {
    const c = changed.get(v.rowId)
    return c ? { ...v, action: c.action, via: null, storeFileId: null, reason: c.reason } : v
  })
}

/** A record the client sees must open from storage: typed (not closed) and not someone's personal file. Else it stays on Drive. */
async function holdBackWhatClientCouldNotOpen(verdicts: RowVerdict[], ownRowIds: Set<string>): Promise<RowVerdict[]> {
  const pointers = verdicts.filter((v) => v.action === "repoint" && v.storeFileId).map((v) => storePointer(v.storeFileId as string))
  if (pointers.length === 0) return verdicts
  const { staffOnlyStorePointers, personalStoreFilesOutsidePerson } = await import("./document-pointer")
  const closed = new Set<string>()
  const personal = new Set<string>()
  for (const part of chunksOf(pointers, 50)) {
    Array.from(await staffOnlyStorePointers(part)).forEach((p) => closed.add(p))
    Array.from(await personalStoreFilesOutsidePerson(part)).forEach((p) => personal.add(p))
  }
  // the database allows ONE record per stored file: a file another record (another company's, for a person in two companies)
  // already points at cannot be pointed at again — this record stays on Drive and is listed
  const d = await db()
  const used = await selectIn<{ id: string; drive_file_id: string }>(pointers, (part) => d.from("documents").select("id, drive_file_id").in("drive_file_id", part), "which stored files already have a record")
  const taken = new Set(used.filter((u) => !ownRowIds.has(u.id)).map((u) => u.drive_file_id))
  return verdicts.map((v) => {
    if (v.action !== "repoint" || !v.storeFileId) return v
    const p = storePointer(v.storeFileId)
    if (taken.has(p)) return { ...v, action: "leave" as const, reason: "another record (another company's) already points at this stored file — stays on Drive" }
    return mustStayOnDrive({ clientSees: v.clientSees, closedToClients: closed.has(p), personalOutsidePerson: personal.has(p) })
      ? { ...v, action: "leave" as const, reason: personal.has(p) ? "a personal file filed under the company — stays on Drive" : "the stored file has no type yet, so the client could not open it — stays on Drive" }
      : v
  })
}

async function plan(f: Facts, deadline: number): Promise<{ blockers: string[]; verdicts: RowVerdict[]; report: GoLiveReport }> {
  const blockers = goLiveBlockers({
    excluded: f.excluded, ownerCount: f.owners.length, ownerIsStudy: f.owners.length === 1 && f.owners[0].study_only,
    hasDoneCopy: f.doneCopyRunIds.length > 0, openMoveRun: f.openMoveRun, openSigning: f.openSigning, state: f.state,
  })
  let verdicts: RowVerdict[]
  if (blockers.length) {
    verdicts = mapRows(f.rows, f.ledger, new Map(), (sd) => (sd ? f.serviceTypes.get(sd) ?? null : null), f.copyStartedAt)
  } else {
    const twins = await findTwins(f, deadline)
    const first = mapRows(f.rows, f.ledger, twins, (sd) => (sd ? f.serviceTypes.get(sd) ?? null : null), f.copyStartedAt)
    const fresh = await holdBackChangedSinceCopy(first, f, deadline)
    verdicts = await holdBackWhatClientCouldNotOpen(fresh, new Set(f.rows.map((r) => r.id)))
  }
  const report = buildGoLiveReport(f.accountId, blockers, f.rows, verdicts)
  report.planHash = planFingerprint(verdicts)
  return { blockers, verdicts, report }
}

/** DRY RUN — reads only. What would happen if this company went live now. */
export async function planGoLive(accountId: string): Promise<GoLiveReport> {
  return (await plan(await loadFacts(accountId), Date.now() + COMPANY_BUDGET_MS)).report
}

export interface GoLiveResult { ok: boolean; runId: string | null; message: string; report: GoLiveReport | null; repointed: number; problems: string[] }

function emptyResult(message: string): GoLiveResult { return { ok: false, runId: null, message, report: null, repointed: 0, problems: [] } }

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
  let blockers: string[], verdicts: RowVerdict[], report: GoLiveReport
  try {
    f = await loadFacts(accountId, runId)
    ;({ blockers, verdicts, report } = await plan(f, deadline))
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    await release(why)
    return emptyResult(`Nothing was switched: ${why}`)
  }
  if (blockers.length) { await release(blockers.join(" ")); return { ...emptyResult(blockers.join(" ")), report } }
  if (opts.expectedPlanHash && opts.expectedPlanHash !== report.planHash) {
    await release("the plan changed since the preview")
    return { ...emptyResult("The company changed since the preview you looked at — run the preview again, then switch."), report }
  }

  const owner = f.owners[0]
  await d.from("store_import_runs").update({ owner_id: owner.id, updated_at: new Date().toISOString() }).eq("id", runId)

  const byId = new Map(f.rows.map((r) => [r.id, r]))
  const toMove = verdicts.filter((v) => v.action === "repoint" && v.storeFileId)
  const problems: string[] = []
  const beat = async () => {
    if (Date.now() > deadline) throw new Error("this company took too long")
    await d.from("store_import_runs").update({ updated_at: new Date().toISOString() }).eq("id", runId).eq("status", "moving")
  }
  try {
    // 2) ledger first, then the record (so a request that dies half-way never loses an old link)
    let n = 0
    for (const v of toMove) {
      if (n++ % 10 === 0) await beat()
      const row = byId.get(v.rowId) as CrmDocRow
      const { data: cur, error: cErr } = await d.from("documents").select("drive_link").eq("id", row.id).maybeSingle()
      if (cErr) throw new Error(`could not read "${row.file_name}" (${cErr.message})`)
      const { error: iErr } = await d.from("store_import_items").insert({
        run_id: runId, source: "drive", source_id: row.drive_file_id, name: row.file_name ?? "document", status: "done", reason: `go-live ${v.via}`,
        store_file_id: v.storeFileId, repointed: [{ id: row.id, drive_file_id: row.drive_file_id, drive_link: (cur?.drive_link as string | null) ?? null }],
      })
      if (iErr) throw new Error(`could not record "${row.file_name}" in the ledger (${iErr.message})`)
      const { data: changed, error: uErr } = await d.from("documents").update({ drive_file_id: storePointer(v.storeFileId as string), drive_link: storeDocumentLink(row.id), updated_at: new Date().toISOString() }).eq("id", row.id).eq("drive_file_id", row.drive_file_id).select("id")
      if (uErr) throw new Error(`could not re-point "${row.file_name}" (${uErr.message})`)
      if (!changed || changed.length !== 1) throw new Error(`"${row.file_name}" changed while the switch was running`)
    }

    // 3) catch-up: records the CRM made after the approved copy are brought in ONE FILE AT A TIME (same rules as a move), each checked
    //    against Drive's own checksum. A file that cannot come over keeps its Drive link (the client still opens it from Drive) and is
    //    listed — it never blocks the switch.
    const catchUp = { brought: 0, stayedOnDrive: [] as string[] }
    {
      const { bringInOneFile } = await import("./drive-import")
      const { getDriveFileChecksum } = await import("@/lib/google-drive")
      const seenDrive = new Set<string>()
      for (const v of verdicts.filter((x) => x.action === "catchup")) {
        await beat()
        const row = byId.get(v.rowId) as CrmDocRow
        if (seenDrive.has(row.drive_file_id)) { catchUp.stayedOnDrive.push(`${row.file_name ?? "document"}: a second record of a file already brought in`); continue }
        seenDrive.add(row.drive_file_id)
        let sum: { md5: string | null; size: number | null } = { md5: null, size: null }
        try { sum = await getDriveFileChecksum(row.drive_file_id) } catch { /* unreadable: the engine will say so */ }
        const r = await bringInOneFile({ runId, accountId, ownerId: owner.id, actorId, file: { driveFileId: row.drive_file_id, name: row.file_name ?? "document", mimeType: row.mime_type ?? null, sizeBytes: sum.size, md5: sum.md5 } })
        if (r.status === "done" && r.repointed > 0) catchUp.brought += 1
        else catchUp.stayedOnDrive.push(`${row.file_name ?? "document"}: ${r.reason ?? r.status}`)
      }
    }

    // 4) prove it: every record the client could see before can still be opened — read back from the database as it is NOW
    await beat()
    const { clientMayOpen } = await import("@/lib/portal/client-store-docs")
    const { readStoreVersionFacts } = await import("./go-live-verify")
    const seen = verdicts.filter((x) => x.clientSees).map((x) => x.rowId)
    type NowRow = { id: string; drive_file_id: string; file_name: string | null; portal_visible: boolean | null; service_delivery_id: string | null; flow_stage: string | null }
    const nowRows = await selectIn<NowRow>(seen, (part) => d.from("documents").select("id, drive_file_id, file_name, portal_visible, service_delivery_id, flow_stage").in("id", part), "the records to check")
    for (const r of nowRows) {
      if (!r.drive_file_id.startsWith("store:")) continue // still a Drive link: unchanged for the client
      const ok = await clientMayOpen({ id: r.id, drive_file_id: r.drive_file_id, portal_visible: r.portal_visible, service_delivery_id: r.service_delivery_id, flow_stage: r.flow_stage })
      if (!ok) problems.push(`"${r.file_name}": the client could not open it from storage`)
      const fileId = r.drive_file_id.slice("store:".length)
      const have = await readStoreVersionFacts(fileId)
      const want = f.ledger.find((l) => l.storeFileId === fileId)
      if (!have) problems.push(`"${r.file_name}": the stored file is missing`)
      else if (want?.sha256 && have.sha256 && have.sha256 !== want.sha256) problems.push(`"${r.file_name}": the stored copy is not the bytes that were approved`)
      else if (want?.size != null && have.size !== want.size) problems.push(`"${r.file_name}": the stored copy is ${have.size} bytes, the original was ${want.size}`)
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
    const { data: closed, error: eErr } = await d.from("store_import_runs").update({
      status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      report: { goLive: true, repointed: toMove.length, caughtUp: catchUp.brought, stayedOnDrive: catchUp.stayedOnDrive, personOwnersFlipped: personCandidates, studyWas: true },
    }).eq("id", runId).eq("status", "moving").select("id")
    if (eErr || !closed || closed.length !== 1) throw new Error(`the switch could not be closed (${eErr?.message ?? "it was changed meanwhile"})`)
    const { error: bErr } = await d.rpc("store_backup_mark_switched", { p_owner_id: owner.id })
    if (bErr) problems.push(`(the backup window could not be started: ${bErr.message})`)
    const total = toMove.length + catchUp.brought
    return {
      ok: true, runId, report,
      message: `${f.companyName} is now in the new storage (${toMove.length} records linked${catchUp.brought ? `, ${catchUp.brought} newer file(s) brought in` : ""}${catchUp.stayedOnDrive.length ? `; ${catchUp.stayedOnDrive.length} newer file(s) stay on Drive` : ""}).`,
      repointed: total, problems: [...catchUp.stayedOnDrive, ...problems],
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    let undoNotes: string[] = []
    try { undoNotes = (await undoGoLive(runId, actorId, { reason: why, internal: true })).problems } catch (u) { undoNotes = [`the automatic undo itself failed: ${u instanceof Error ? u.message : String(u)} — it will be retried by the sweeper`] }
    return { ok: false, runId, report, repointed: 0, message: `Nothing was switched: ${why}.${undoNotes.length ? ` (Undo notes: ${undoNotes.join("; ")})` : ""}`, problems: [...problems, ...undoNotes] }
  }
}

/**
 * Undo a go-live: records put back on their old links, the company back to a hidden study copy. Files in storage are never deleted.
 * Only a go-live run can be undone (never a copy run); an open run only by the switch itself (`internal`) or once it is dead (stale).
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
  const { data: items, error: iErr } = await d.from("store_import_items").select("repointed").eq("run_id", runId)
  if (iErr) throw new Error(`the undo could not read the ledger (${iErr.message})`)
  let restored = 0
  for (const it of (items ?? []) as Array<{ repointed: Array<{ id: string; drive_file_id: string; drive_link: string | null }> }>) {
    for (const r of it.repointed ?? []) {
      const { error: e, count } = await d.from("documents").update({ drive_file_id: r.drive_file_id, drive_link: r.drive_link, updated_at: new Date().toISOString() }, { count: "exact" }).eq("id", r.id).like("drive_file_id", "store:%")
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
