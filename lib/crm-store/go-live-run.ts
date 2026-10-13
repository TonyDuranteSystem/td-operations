/**
 * CRM Store — go live for ONE company: the database part (master plan Part 33, dev job ad09ea91).
 * The decisions are pure and live in ./go-live.ts; this file reads the facts, writes the ledger and the records, proves the
 * client can still open everything, and flips the company. See go-live.ts for the six steps.
 */

import {
  buildGoLiveReport, goLiveAllowed, goLiveBlockers, isExcludedCompany, mapRows, mustStayOnDrive, storeDocumentLink, storePointer,
  type CrmDocRow, type GoLiveReport, type LedgerFile, type RowVerdict,
} from "./go-live"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until production
async function db(): Promise<any> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return supabaseAdmin
}

const OPEN_ESIGN_NOT = ["completed", "cancelled", "canceled", "declined", "expired", "void", "voided", "draft"]

interface Facts {
  accountId: string
  companyName: string
  excluded: boolean
  owners: Array<{ id: string; study_only: boolean }>
  doneCopyRunIds: string[]
  openMoveRun: boolean
  openSigning: boolean
  state: "drive" | "moving" | "store"
  ledger: LedgerFile[]
  rows: CrmDocRow[]
  serviceTypes: Map<string, string | null>
}

async function loadFacts(accountId: string): Promise<Facts> {
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
    ? (must(await d.from("store_import_runs").select("id").in("owner_id", ownerIds).eq("mode", "copy").eq("status", "done"), "the copy runs") as Array<{ id: string }>)
    : []
  const openRuns = must(await d.from("store_import_runs").select("id").eq("account_id", accountId).eq("mode", "move").in("status", ["scanning", "moving", "undoing"]), "open moves") as Array<{ id: string }>
  const { companyDocState } = await import("./switched-drive-guard")
  const state = await companyDocState(accountId)

  const openEsign = must(await d.from("esign_envelopes").select("id").eq("owner_account_id", accountId).not("status", "in", `(${OPEN_ESIGN_NOT.join(",")})`).limit(1), "open signings") as unknown[]
  const openSs4 = must(await d.from("ss4_applications").select("id").eq("account_id", accountId).eq("status", "awaiting_signature").limit(1), "open SS-4s") as unknown[]
  const openSig = must(await d.from("signature_requests").select("id").eq("account_id", accountId).eq("status", "awaiting_signature").limit(1), "open signature requests") as unknown[]

  const ledger: LedgerFile[] = []
  for (const runId of copyRuns.map((r) => r.id)) {
    const items = must(await d.from("store_import_items").select("source_id, store_file_id, source_md5, size_bytes").eq("run_id", runId).eq("source", "drive").in("status", ["done", "merged"]).not("store_file_id", "is", null), "the copy ledger") as Array<{ source_id: string; store_file_id: string; source_md5: string | null; size_bytes: number | null }>
    for (const i of items) ledger.push({ sourceId: i.source_id, storeFileId: i.store_file_id, md5: i.source_md5, size: i.size_bytes })
  }

  const rows = must(await d.from("documents").select("id, drive_file_id, file_name, contact_id, portal_visible, service_delivery_id, flow_stage, created_at").eq("account_id", accountId), "the company's documents") as CrmDocRow[]
  const sdIds = Array.from(new Set(rows.map((r) => r.service_delivery_id).filter((x): x is string => !!x)))
  const serviceTypes = new Map<string, string | null>()
  if (sdIds.length) {
    const sds = must(await d.from("service_deliveries").select("id, service_type").in("id", sdIds), "service types") as Array<{ id: string; service_type: string | null }>
    for (const s of sds) serviceTypes.set(s.id, s.service_type)
  }

  return {
    accountId, companyName: acct.company_name as string, excluded: isExcludedCompany({ id: accountId, status: (acct.status as string | null) ?? null, name: acct.company_name as string }),
    owners, doneCopyRunIds: copyRuns.map((r) => r.id), openMoveRun: openRuns.length > 0,
    openSigning: openEsign.length + openSs4.length + openSig.length > 0, state, ledger, rows, serviceTypes,
  }
}

/** Twin detection: a Drive file NOT in the ledger whose bytes (checksum + size) equal a ledger file's. Read-only Drive calls. */
async function findTwins(f: Facts): Promise<Map<string, LedgerFile>> {
  const inLedger = new Set(f.ledger.map((l) => l.sourceId))
  const byKey = new Map<string, LedgerFile>()
  for (const l of f.ledger) if (l.md5 && l.size != null) byKey.set(`${l.md5}:${l.size}`, l)
  const out = new Map<string, LedgerFile>()
  if (byKey.size === 0) return out
  const { getDriveFileChecksum } = await import("@/lib/google-drive")
  for (const r of f.rows) {
    if (r.contact_id || r.drive_file_id.startsWith("store:") || r.drive_file_id.startsWith("storage:") || inLedger.has(r.drive_file_id)) continue
    try {
      const c = await getDriveFileChecksum(r.drive_file_id)
      if (c.md5 && c.size != null) {
        const hit = byKey.get(`${c.md5}:${c.size}`)
        if (hit) out.set(r.id, hit)
      }
    } catch { /* a dead or unreadable Drive link: no twin — the record stays on Drive and is listed */ }
  }
  return out
}

/** A record the client sees must open from storage: typed (not closed) and not someone's personal file. Else it stays on Drive. */
async function holdBackWhatClientCouldNotOpen(verdicts: RowVerdict[]): Promise<RowVerdict[]> {
  const pointers = verdicts.filter((v) => v.action === "repoint" && v.storeFileId).map((v) => storePointer(v.storeFileId as string))
  if (pointers.length === 0) return verdicts
  const { staffOnlyStorePointers, personalStoreFilesOutsidePerson } = await import("./document-pointer")
  const [closed, personal] = await Promise.all([staffOnlyStorePointers(pointers), personalStoreFilesOutsidePerson(pointers)])
  return verdicts.map((v) => {
    if (v.action !== "repoint" || !v.storeFileId) return v
    const p = storePointer(v.storeFileId)
    return mustStayOnDrive({ clientSees: v.clientSees, closedToClients: closed.has(p), personalOutsidePerson: personal.has(p) })
      ? { ...v, action: "leave" as const, reason: personal.has(p) ? "a personal file filed under the company — stays on Drive" : "the stored file has no type yet, so the client could not open it — stays on Drive" }
      : v
  })
}

async function plan(f: Facts): Promise<{ blockers: string[]; verdicts: RowVerdict[]; report: GoLiveReport }> {
  const blockers = goLiveBlockers({
    excluded: f.excluded, ownerCount: f.owners.length, ownerIsStudy: f.owners.length === 1 && f.owners[0].study_only,
    hasDoneCopy: f.doneCopyRunIds.length > 0, openMoveRun: f.openMoveRun, openSigning: f.openSigning, state: f.state,
  })
  const twins = blockers.length ? new Map<string, LedgerFile>() : await findTwins(f)
  const first = mapRows(f.rows, f.ledger, twins, (sd) => (sd ? f.serviceTypes.get(sd) ?? null : null))
  const verdicts = blockers.length ? first : await holdBackWhatClientCouldNotOpen(first)
  return { blockers, verdicts, report: buildGoLiveReport(f.accountId, blockers, f.rows, verdicts) }
}

/** DRY RUN — reads only. What would happen if this company went live now. */
export async function planGoLive(accountId: string): Promise<GoLiveReport> {
  return (await plan(await loadFacts(accountId))).report
}

export interface GoLiveResult { ok: boolean; runId: string | null; message: string; report: GoLiveReport; repointed: number; problems: string[] }

export async function runGoLive(accountId: string, actorId: string | null): Promise<GoLiveResult> {
  if (!goLiveAllowed()) throw new Error("Going live is switched off in this environment.")
  if (!actorId) throw new Error("Only a signed-in owner can switch a company.")
  const f = await loadFacts(accountId)
  const { blockers, verdicts, report } = await plan(f)
  if (blockers.length) return { ok: false, runId: null, message: blockers.join(" "), report, repointed: 0, problems: [] }

  const d = await db()
  const owner = f.owners[0]
  // 1) the lock: the database allows ONE open run per company, so a second request fails right here
  const { data: run, error: rErr } = await d.from("store_import_runs").insert({ account_id: accountId, owner_id: owner.id, status: "moving", mode: "move", started_by: actorId, report: { goLive: true } }).select("id").maybeSingle()
  if (rErr || !run) return { ok: false, runId: null, message: "Another switch or move is already open for this company.", report, repointed: 0, problems: [] }
  const runId = run.id as string

  const byId = new Map(f.rows.map((r) => [r.id, r]))
  const toMove = verdicts.filter((v) => v.action === "repoint" && v.storeFileId)
  const problems: string[] = []
  try {
    // 2) ledger first, then the record (so a request that dies half-way never loses an old link)
    for (const v of toMove) {
      const row = byId.get(v.rowId) as CrmDocRow
      const { error: iErr } = await d.from("store_import_items").insert({
        run_id: runId, source: "drive", source_id: row.drive_file_id, name: row.file_name ?? "document", status: "done", reason: `go-live ${v.via}`,
        store_file_id: v.storeFileId, repointed: [{ id: row.id, drive_file_id: row.drive_file_id, drive_link: null }],
      })
      if (iErr) throw new Error(`could not record "${row.file_name}" in the ledger (${iErr.message})`)
      const { data: cur } = await d.from("documents").select("drive_link").eq("id", row.id).maybeSingle()
      await d.from("store_import_items").update({ repointed: [{ id: row.id, drive_file_id: row.drive_file_id, drive_link: (cur?.drive_link as string | null) ?? null }] }).eq("run_id", runId).eq("source_id", row.drive_file_id)
      const { error: uErr } = await d.from("documents").update({ drive_file_id: storePointer(v.storeFileId as string), drive_link: storeDocumentLink(row.id), updated_at: new Date().toISOString() }).eq("id", row.id).eq("drive_file_id", row.drive_file_id)
      if (uErr) throw new Error(`could not re-point "${row.file_name}" (${uErr.message})`)
    }

    // 3) prove it: every record the client could see before can still be opened, from storage or Drive
    const { clientMayOpen } = await import("@/lib/portal/client-store-docs")
    const { readStoreVersionSize } = await import("./go-live-verify")
    for (const v of verdicts.filter((x) => x.clientSees)) {
      const row = byId.get(v.rowId) as CrmDocRow
      if (v.action === "repoint" && v.storeFileId) {
        const pointer = storePointer(v.storeFileId)
        const ok = await clientMayOpen({ id: row.id, drive_file_id: pointer, portal_visible: row.portal_visible, service_delivery_id: row.service_delivery_id, flow_stage: row.flow_stage })
        if (!ok) problems.push(`"${row.file_name}": the client could not open it from storage`)
        const want = f.ledger.find((l) => l.storeFileId === v.storeFileId)?.size ?? null
        const have = await readStoreVersionSize(v.storeFileId)
        if (have == null) problems.push(`"${row.file_name}": the stored file is missing`)
        else if (want != null && have !== want) problems.push(`"${row.file_name}": the stored copy is ${have} bytes, the original was ${want}`)
      }
    }
    if (problems.length) throw new Error(`the check found differences: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`)

    // 4) flip — only now
    const { error: fErr } = await d.from("store_owners").update({ study_only: false }).eq("id", owner.id).eq("study_only", true)
    if (fErr) throw new Error(`the company could not be switched (${fErr.message})`)
    await d.from("store_import_runs").update({ status: "done", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { goLive: true, repointed: toMove.length, studyWas: true } }).eq("id", runId)
    await d.rpc("store_backup_mark_switched", { p_owner_id: owner.id })
    return { ok: true, runId, message: `${f.companyName} is now in the new storage (${toMove.length} records linked).`, report, repointed: toMove.length, problems: [] }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    const undone = await undoGoLive(runId, actorId, { reason: why })
    return { ok: false, runId, message: `Nothing was switched: ${why}.${undone.problems.length ? ` (Undo notes: ${undone.problems.join("; ")})` : ""}`, report, repointed: 0, problems: [...problems, ...undone.problems] }
  }
}

/** Undo: records put back on their old links, the company back to a hidden study copy. Files in storage are never deleted. */
export async function undoGoLive(runId: string, actorId: string | null, opts: { reason?: string } = {}): Promise<{ restored: number; problems: string[]; filesAddedSince: number }> {
  if (!actorId) throw new Error("Only a signed-in owner can undo a switch.")
  const d = await db()
  const { data: run, error } = await d.from("store_import_runs").select("id, owner_id, status, finished_at").eq("id", runId).maybeSingle()
  if (error || !run) throw new Error("Switch not found.")
  const problems: string[] = []
  await d.from("store_import_runs").update({ status: "undoing", updated_at: new Date().toISOString() }).eq("id", runId).in("status", ["moving", "done", "incomplete", "failed", "undoing"])
  const { data: items } = await d.from("store_import_items").select("repointed, store_file_id").eq("run_id", runId)
  let restored = 0
  for (const it of (items ?? []) as Array<{ repointed: Array<{ id: string; drive_file_id: string; drive_link: string | null }>; store_file_id: string | null }>) {
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
    await d.from("store_owners").update({ study_only: true }).eq("id", run.owner_id).eq("study_only", false)
    await d.from("store_backup_state").update({ switched_at: null, updated_at: new Date().toISOString() }).eq("owner_id", run.owner_id)
  }
  await d.from("store_import_runs").update({ status: "rolled_back", finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: { goLive: true, undone: true, reason: opts.reason ?? null, problems } }).eq("id", runId)
  return { restored, problems, filesAddedSince }
}
