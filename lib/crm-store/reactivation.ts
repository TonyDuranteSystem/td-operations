/**
 * Reactivation brings a company's OLD DOCUMENTS BACK INTO STORAGE (Storage check Phase 3, slice 3a; dev job f855295a;
 * Antonio 2026-10-17: "when a company is reactivated its old documents are brought back into storage").
 *
 * Trigger: a row in `account_status_events` (left by a database trigger) whose status went from Closed / Cancelled / Offboarding /
 * Delinquent back to Active. A cron (`/api/cron/reactivation-storage`, every 5 min, switch STORE_REACTIVATION=1, default OFF) walks
 * every such company through the SAME machinery that brought the other ~280 companies into storage — nothing new is invented:
 *
 *   already has a live storage ............ nothing to bring in (a reactivation twice lands here) — one note
 *   no Drive folder, no CRM documents ..... an empty live storage (like the One-Time customers)
 *   no Drive folder, but CRM documents .... stop: a person must look (nothing is guessed)
 *   otherwise ............................ COPY the old Drive folder into a hidden study storage (drive-import: types from the CRM
 *                                          labels, personal papers to the person's own storage, exact duplicates recorded as merged,
 *                                          Google Docs/shortcuts listed and left) in budgeted batches; a copy that stopped on a
 *                                          failure is resumed (failed files re-queued, at most MAX_RETRIES times);
 *                                          THEN the go-live (clean listing, self-check, undo) switches it. The Drive-write guard blocks
 *                                          Drive writes only once the storage is live — a half-copied company is never "switched".
 *   after the switch ..................... the company's tax-year folders (from its own tax records), then the Storage check (Phase 1)
 *
 * Every step posts ONE plain-English staff-only note in the Calendar's What's New (key-based: a note is posted once). State lives in the
 * sysdoc row `reactivation-storage` (per status event: step, retries, notes already posted). Nothing is deleted anywhere; STORE_GO_LIVE
 * is not needed (and stays off); the night run and the owner's go-live button are untouched.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* / system_docs / account_status_events are not in the generated types
const db = () => supabaseAdmin as any

export const REACTIVATION_SLUG = "reactivation-storage"
/** statuses a company can come back from (the client no longer saw it in the portal) */
export const REACTIVATED_FROM: ReadonlySet<string> = new Set(["Closed", "Cancelled", "Offboarding", "Delinquent"])
export const MAX_RETRIES = 3
/** events older than this are not picked up (a switch turned on late must not wake old history) */
export const LOOKBACK_DAYS = 14

// ───────────────────────────────────────────────────────────── pure part (unit-tested)

/** Pure: is this status change a reactivation? */
export function isReactivation(oldStatus: string | null, newStatus: string | null): boolean {
  return newStatus === "Active" && !!oldStatus && REACTIVATED_FROM.has(oldStatus)
}

export interface ReactFacts {
  status: string | null
  excluded: boolean
  hasLiveOwner: boolean
  hasAnyOwner: boolean
  hasDoneCopy: boolean
  /** an open copy run (scanning/moving) */
  openCopyRunId: string | null
  /** a copy that finished with failed files */
  incompleteRunId: string | null
  failedFiles: number
  /** failed files worth another try (not "too large") */
  retriableFiles: number
  retries: number
  openMoveRun: boolean
  hasDriveFolder: boolean
  documentCount: number
}

export type ReactStep =
  | "abandon" | "already_in_storage" | "empty_storage" | "needs_person_no_folder" | "wait_other_move"
  | "continue_copy" | "retry_failed" | "needs_person_copy" | "go_live" | "start_copy"

/** Pure: what to do next for this company. Every branch is a single decision with a plain reason elsewhere. */
export function nextStep(f: ReactFacts): ReactStep {
  if (f.status !== "Active" || f.excluded) return "abandon"
  if (f.hasLiveOwner) return "already_in_storage"
  if (f.openMoveRun) return "wait_other_move"
  if (f.openCopyRunId) return "continue_copy"
  if (f.incompleteRunId) return f.retriableFiles > 0 && f.retries < MAX_RETRIES ? "retry_failed" : "needs_person_copy"
  if (f.hasDoneCopy) return "go_live"
  if (!f.hasDriveFolder) return f.documentCount === 0 && !f.hasAnyOwner ? "empty_storage" : "needs_person_no_folder"
  return "start_copy"
}

export interface Note { key: string; headline: string; lines: string[] }

/** Pure: a short stable fingerprint (a note key must not carry free text). */
export function shortHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Pure: the plain-English note for a step. `d` carries the few numbers/names each one states. */
export function composeNote(kind: "start" | "done" | "already" | "empty" | "waiting" | "needs_person" | "abandoned", d: {
  files?: number; stored?: number; reused?: number; created?: number; archived?: number; leftAsIs?: number
  skippedNames?: string[]; years?: number[]; findings?: string[]; why?: string; status?: string | null
}): Note {
  switch (kind) {
    case "start":
      return { key: "start", headline: "is Active again — its old documents are being brought back into storage", lines: [`Copying ${plural(d.files ?? 0, "file")} from its old Drive folder. Nothing in the old Drive is changed or deleted, and the client sees none of it until you decide.`] }
    case "already":
      return { key: "already", headline: "is Active again and already has its storage", lines: ["Nothing had to be brought in; its storage is as it was."] }
    case "empty":
      return { key: "empty", headline: "is Active again — it has no old documents, so it got an empty storage", lines: ["It had no Drive folder and no documents in the CRM."] }
    case "waiting":
      return { key: `waiting-${shortHash(d.why ?? "")}`, headline: "is waiting before its storage can be switched on", lines: [d.why ?? "Something is still open.", "It will continue by itself when that is cleared."] }
    case "needs_person":
      return { key: "needs_person", headline: "is Active again but a person has to look at its old documents", lines: [d.why ?? "The automatic step stopped.", "Nothing was switched and nothing was deleted; the old Drive folder is still the only copy."] }
    case "abandoned":
      return { key: "abandoned", headline: "was reactivated but is no longer Active — the storage step stopped", lines: [`Its status is now ${d.status ?? "different"}. Nothing was switched.`] }
    case "done": {
      const lines = [
        `Its old documents are back in storage: ${plural(d.stored ?? 0, "file")} stored; ${plural(d.reused ?? 0, "old CRM record")} reused and relabelled, ${plural(d.created ?? 0, "new record")} made, ${plural(d.archived ?? 0, "old record")} archived (kept for staff, not shown).`,
        "The client sees none of it until you decide, file by file, in Storage.",
      ]
      if ((d.leftAsIs ?? 0) > 0) lines.push(`${plural(d.leftAsIs ?? 0, "record")} (workspace documents, SS-4s, or made after the copy) were left exactly as they are.`)
      if ((d.skippedNames ?? []).length) lines.push(`Left in the old Drive (Google Docs / shortcuts): ${(d.skippedNames ?? []).slice(0, 5).join(", ")}${(d.skippedNames ?? []).length > 5 ? ` and ${(d.skippedNames ?? []).length - 5} more` : ""}.`)
      if ((d.years ?? []).length) lines.push(`Tax-year folders ready: ${(d.years ?? []).join(", ")}.`)
      lines.push((d.findings ?? []).length ? `Storage check — ${plural((d.findings ?? []).length, "thing")} to look at: ${(d.findings ?? []).slice(0, 5).join("; ")}.` : "Storage check: nothing to flag (people, members and name match).")
      return { key: "done", headline: "is back in storage", lines }
    }
  }
}

/** Pure: should this copy failure be tried again? */
export function isRetriableFailure(reason: string | null | undefined): boolean {
  return !/too large/i.test(reason ?? "")
}

export interface Item {
  eventId: string
  accountId: string
  company: string
  status: "running" | "done" | "needs_person" | "skipped"
  retries: number
  /** keys of the notes already posted (a note is posted once) */
  notes: string[]
  startedAt: string
  updatedAt: string
  summary?: string
}
export interface State { items: Item[]; lockUntil: string | null; updatedAt?: string }

/** Pure: add the reactivation events we do not know yet (oldest first). */
export function enqueue(state: State, events: Array<{ id: string; account_id: string; old_status: string | null; new_status: string | null; created_at: string }>, names: Map<string, string>, now = new Date()): State {
  const known = new Set(state.items.map((i) => i.eventId))
  const cutoff = now.getTime() - LOOKBACK_DAYS * 86_400_000
  const add: Item[] = []
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (known.has(e.id) || !isReactivation(e.old_status, e.new_status) || Date.parse(e.created_at) < cutoff) continue
    add.push({ eventId: e.id, accountId: e.account_id, company: names.get(e.account_id) ?? "A company", status: "running", retries: 0, notes: [], startedAt: now.toISOString(), updatedAt: now.toISOString() })
  }
  return { ...state, items: [...state.items, ...add] }
}

// ───────────────────────────────────────────────────────────── the step runner (dependencies injected → tested without a database)

export interface GoLiveSummary { ok: boolean; message: string; blockers: string[]; stored: number; reused: number; created: number; archived: number; leftAsIs: number }
export interface Deps {
  facts(accountId: string, retries: number): Promise<ReactFacts>
  startCopy(accountId: string): Promise<{ runId: string; files: number }>
  continueCopy(runId: string, budgetMs: number): Promise<{ status: string; pending: number; skippedNames: string[] }>
  requeueFailed(runId: string): Promise<number>
  failedReasons(accountId: string): Promise<string[]>
  planGoLive(accountId: string): Promise<{ blockers: string[]; planHash: string | null }>
  goLive(accountId: string, planHash: string | null): Promise<GoLiveSummary>
  emptyStorage(accountId: string, company: string): Promise<void>
  afterSwitch(accountId: string): Promise<{ years: number[]; findings: string[] }>
  skippedNames(accountId: string): Promise<string[]>
  note(item: Item, n: Note): Promise<boolean>
  now(): number
}

async function say(item: Item, deps: Deps, n: Note): Promise<void> {
  if (item.notes.includes(n.key)) return
  if (await deps.note(item, n)) item.notes.push(n.key)
}

/**
 * Runs the steps for ONE company until it is finished, has to wait, or the time is up. Returns the updated item (never throws: an error is
 * counted as a retry, and after MAX_RETRIES a person is asked to look).
 */
export async function advance(item: Item, deps: Deps, budgetMs: number): Promise<Item> {
  const deadline = deps.now() + budgetMs
  const it: Item = { ...item, notes: [...item.notes] }
  const stop = (status: Item["status"], summary: string) => { it.status = status; it.summary = summary; it.updatedAt = new Date(deps.now()).toISOString() }
  try {
    for (let guard = 0; guard < 12 && deps.now() < deadline; guard++) {
      const f = await deps.facts(it.accountId, it.retries)
      const step = nextStep(f)
      if (step === "abandon") { await say(it, deps, composeNote("abandoned", { status: f.status })); stop("skipped", `not Active any more (${f.status})`); break }
      if (step === "already_in_storage") { await say(it, deps, composeNote("already", {})); stop("done", "already in storage"); break }
      if (step === "empty_storage") { await deps.emptyStorage(it.accountId, it.company); await say(it, deps, composeNote("empty", {})); stop("done", "empty storage made"); break }
      if (step === "needs_person_no_folder") { await say(it, deps, composeNote("needs_person", { why: "It has documents in the CRM but no old Drive folder to copy them from." })); stop("needs_person", "documents but no Drive folder"); break }
      if (step === "wait_other_move") { await say(it, deps, composeNote("waiting", { why: "Another move or switch of this company is still open." })); break }
      if (step === "start_copy") { const r = await deps.startCopy(it.accountId); await say(it, deps, composeNote("start", { files: r.files })); continue }
      if (step === "continue_copy") {
        const r = await deps.continueCopy(f.openCopyRunId as string, Math.max(1_000, deadline - deps.now()))
        if (r.pending > 0) break // out of time: the next run continues
        continue
      }
      if (step === "retry_failed") { await deps.requeueFailed(f.incompleteRunId as string); it.retries++; continue }
      if (step === "needs_person_copy") {
        const reasons = await deps.failedReasons(it.accountId)
        await say(it, deps, composeNote("needs_person", { why: `${plural(f.failedFiles, "file")} could not be copied${reasons.length ? ` (${Array.from(new Set(reasons)).slice(0, 3).join("; ")})` : ""}.` }))
        stop("needs_person", "copy has failed files"); break
      }
      if (step === "go_live") {
        const p = await deps.planGoLive(it.accountId)
        if (p.blockers.length) { await say(it, deps, composeNote("waiting", { why: p.blockers.join(" ") })); break }
        const r = await deps.goLive(it.accountId, p.planHash)
        if (!r.ok) { it.retries++; if (it.retries >= MAX_RETRIES) { await say(it, deps, composeNote("needs_person", { why: r.message })); stop("needs_person", "switch refused") } break }
        const after = await deps.afterSwitch(it.accountId)
        await say(it, deps, composeNote("done", { stored: r.stored, reused: r.reused, created: r.created, archived: r.archived, leftAsIs: r.leftAsIs, skippedNames: await deps.skippedNames(it.accountId), years: after.years, findings: after.findings }))
        stop("done", "back in storage"); break
      }
    }
  } catch (e) {
    it.retries++
    const why = e instanceof Error ? e.message : String(e)
    if (it.retries >= MAX_RETRIES) { await say(it, deps, composeNote("needs_person", { why: `The automatic step stopped with an error: ${why}` })); stop("needs_person", why) }
    else it.summary = `retry ${it.retries}: ${why}`
  }
  it.updatedAt = new Date(deps.now()).toISOString()
  return it
}

// ───────────────────────────────────────────────────────────── real dependencies + the batch (used by the cron)

export function realDeps(): Deps {
  return {
    async facts(accountId, retries) {
      const { data: acct } = await db().from("accounts").select("id, company_name, status, drive_folder_id").eq("id", accountId).maybeSingle()
      if (!acct) return { status: null, excluded: true, hasLiveOwner: false, hasAnyOwner: false, hasDoneCopy: false, openCopyRunId: null, incompleteRunId: null, failedFiles: 0, retriableFiles: 0, retries, openMoveRun: false, hasDriveFolder: false, documentCount: 0 }
      const { isExcludedCompany } = await import("./go-live")
      const { data: owners } = await db().from("store_owners").select("id, study_only").eq("account_id", accountId).eq("kind", "company")
      const ownerIds = ((owners ?? []) as Array<{ id: string }>).map((o) => o.id)
      const { data: runs } = await db().from("store_import_runs").select("id, mode, status, report, started_at").eq("account_id", accountId).order("started_at", { ascending: false })
      const all = (runs ?? []) as Array<{ id: string; mode: string; status: string; report: { goLive?: boolean; catchUp?: boolean } | null }>
      const copies = all.filter((r) => r.mode === "copy")
      const openCopy = copies.find((r) => ["scanning", "moving"].includes(r.status)) ?? null
      const incomplete = copies.find((r) => r.status === "incomplete") ?? null
      const openMove = all.some((r) => r.mode === "move" && ["scanning", "moving", "undoing"].includes(r.status))
      let failedFiles = 0, retriable = 0
      if (incomplete) {
        const { data: items } = await db().from("store_import_items").select("reason").eq("run_id", incomplete.id).eq("status", "failed")
        for (const i of (items ?? []) as Array<{ reason: string | null }>) { failedFiles++; if (isRetriableFailure(i.reason)) retriable++ }
      }
      const { count } = await db().from("documents").select("id", { count: "exact", head: true }).eq("account_id", accountId)
      return {
        status: (acct.status as string | null) ?? null,
        excluded: isExcludedCompany({ id: accountId, status: (acct.status as string | null) ?? null, name: acct.company_name as string }),
        hasLiveOwner: ((owners ?? []) as Array<{ study_only: boolean }>).some((o) => o.study_only === false),
        hasAnyOwner: ownerIds.length > 0,
        hasDoneCopy: copies.some((r) => r.status === "done"),
        openCopyRunId: openCopy?.id ?? null, incompleteRunId: incomplete?.id ?? null, failedFiles, retriableFiles: retriable, retries,
        openMoveRun: openMove, hasDriveFolder: !!acct.drive_folder_id, documentCount: count ?? 0,
      }
    },
    async startCopy(accountId) {
      const { startDriveImport } = await import("./drive-import")
      const v = await startDriveImport(accountId, null, { mode: "copy", automatic: true })
      return { runId: v.id, files: v.counts.total }
    },
    async continueCopy(runId, budgetMs) {
      const { continueDriveImport, runView } = await import("./drive-import")
      const t0 = Date.now()
      let v = await runView(runId)
      while (v.status === "moving" && Date.now() - t0 < budgetMs - 5_000) {
        v = await continueDriveImport(runId, null, { files: 25, ms: Math.min(40_000, Math.max(5_000, budgetMs - (Date.now() - t0) - 2_000)) })
      }
      return { status: v.status, pending: v.status === "moving" ? v.counts.pending + v.counts.working : 0, skippedNames: [] }
    },
    async requeueFailed(runId) {
      const { data: items } = await db().from("store_import_items").select("id, reason").eq("run_id", runId).eq("status", "failed")
      const ids = ((items ?? []) as Array<{ id: string; reason: string | null }>).filter((i) => isRetriableFailure(i.reason)).map((i) => i.id)
      if (!ids.length) return 0
      await db().from("store_import_items").update({ status: "pending", reason: null, updated_at: new Date().toISOString() }).in("id", ids).eq("status", "failed")
      await db().from("store_import_runs").update({ status: "moving", finished_at: null, updated_at: new Date().toISOString() }).eq("id", runId).eq("status", "incomplete")
      return ids.length
    },
    async failedReasons(accountId) {
      const { data: run } = await db().from("store_import_runs").select("id").eq("account_id", accountId).eq("mode", "copy").eq("status", "incomplete").order("started_at", { ascending: false }).limit(1).maybeSingle()
      if (!run) return []
      const { data: items } = await db().from("store_import_items").select("name, reason").eq("run_id", run.id).eq("status", "failed").limit(5)
      return ((items ?? []) as Array<{ name: string; reason: string | null }>).map((i) => `${i.name}: ${i.reason ?? "failed"}`)
    },
    async planGoLive(accountId) {
      const { planGoLive } = await import("./go-live-run")
      const r = await planGoLive(accountId)
      return { blockers: r.blockers, planHash: r.planHash ?? null }
    },
    async goLive(accountId, planHash) {
      const { runGoLive } = await import("./go-live-run")
      const r = await runGoLive(accountId, null, { automatic: true, expectedPlanHash: planHash ?? undefined })
      return {
        ok: r.ok, message: r.message, blockers: r.report?.blockers ?? [],
        stored: r.report?.listing.storedFiles ?? 0, reused: r.report?.listing.reusedRecords ?? 0, created: r.report?.listing.newRecords ?? 0,
        archived: r.report?.listing.archivedRecords ?? 0, leftAsIs: r.report?.listing.untouched ?? 0,
      }
    },
    async emptyStorage(accountId, company) {
      const { COMPANY_TEMPLATE, storeSafeFolderName } = await import("./formation-pilot")
      const { data: ownerId, error } = await db().rpc("store_ensure_owner", { p_kind: "company", p_ref: accountId })
      if (error || !ownerId) throw new Error(`The company's storage could not be created (${error?.message ?? "no id"}).`)
      const { error: tErr } = await db().rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(company) })
      if (tErr) throw new Error(`The company's folders could not be created (${tErr.message}).`)
    },
    async afterSwitch(accountId) {
      const out = { years: [] as number[], findings: [] as string[] }
      try {
        const { liveOwnerOfAccount } = await import("./switched-drive-guard")
        const ownerId = await liveOwnerOfAccount(accountId)
        const { data: tr } = await db().from("tax_returns").select("tax_year").eq("account_id", accountId)
        const thisYear = new Date().getFullYear()
        const years = Array.from(new Set(((tr ?? []) as Array<{ tax_year: number | null }>).map((r) => r.tax_year).filter((y): y is number => typeof y === "number" && y >= 2000 && y <= thisYear + 1))).sort()
        if (ownerId && years.length) {
          const pilot = await import("./formation-pilot")
          const { ensureYearFolder } = await import("./save-form")
          const tax = await pilot.folderOfKind(ownerId, "tax")
          for (const y of years) { await ensureYearFolder(tax, String(y)); out.years.push(y) }
        }
      } catch { /* the folders are made when a file lands; not a reason to fail the switch */ }
      try {
        const { storageCheckFor } = await import("./storage-check")
        out.findings = (await storageCheckFor(accountId)).findings.map((x) => x.title)
      } catch { /* the pop-up on the company page shows it anyway */ }
      return out
    },
    async skippedNames(accountId) {
      const { data: run } = await db().from("store_import_runs").select("id").eq("account_id", accountId).eq("mode", "copy").eq("status", "done").order("started_at", { ascending: false }).limit(1).maybeSingle()
      if (!run) return []
      const { data: items } = await db().from("store_import_items").select("name").eq("run_id", run.id).eq("status", "skipped").limit(20)
      return ((items ?? []) as Array<{ name: string }>).map((i) => i.name)
    },
    async note(item, n) {
      const { emitStorageReactivationNote } = await import("@/lib/portal/chat-events")
      const r = await emitStorageReactivationNote({ eventId: item.eventId, key: n.key, accountId: item.accountId, companyName: item.company, headline: n.headline, lines: n.lines })
      return r.emitted || r.reason === "already_emitted"
    },
    now: () => Date.now(),
  }
}

async function load(): Promise<State> {
  const { data, error } = await db().from("system_docs").select("content").eq("slug", REACTIVATION_SLUG).maybeSingle()
  if (error) throw new Error("Could not read the reactivation state.")
  if (!data?.content) return { items: [], lockUntil: null }
  try { return JSON.parse(data.content as string) as State } catch { return { items: [], lockUntil: null } }
}
async function save(state: State): Promise<void> {
  const row = { slug: REACTIVATION_SLUG, title: "Reactivation: old documents back into storage", doc_type: "report", content: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), agent_readable: false, updated_at: new Date().toISOString() }
  // update-then-insert (not upsert): the sandbox table has no unique index on the slug
  const { data: had, error: rErr } = await db().from("system_docs").select("id").eq("slug", REACTIVATION_SLUG).limit(1)
  if (rErr) throw new Error("Could not save the reactivation state.")
  const { error } = had && had.length > 0
    ? await db().from("system_docs").update({ content: row.content, updated_at: row.updated_at }).eq("slug", REACTIVATION_SLUG)
    : await db().from("system_docs").insert(row)
  if (error) throw new Error("Could not save the reactivation state.")
}

export interface BatchResult { enabled: boolean; picked: number; running: number; done: number; needsPerson: number; skipped: number; busy?: boolean; tableMissing?: boolean }

export async function runReactivationBatch(opts: { budgetMs: number }, deps: Deps = realDeps()): Promise<BatchResult> {
  const { reactivationAllowed } = await import("./go-live")
  const zero = { picked: 0, running: 0, done: 0, needsPerson: 0, skipped: 0 }
  if (!reactivationAllowed()) return { enabled: false, ...zero }
  const t0 = Date.now()
  let state = await load()
  if (state.lockUntil && Date.parse(state.lockUntil) > Date.now()) return { enabled: true, ...zero, busy: true }
  state = { ...state, lockUntil: new Date(Date.now() + opts.budgetMs + 60_000).toISOString() }
  await save(state)
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()
    const { data: events, error } = await db().from("account_status_events").select("id, account_id, old_status, new_status, created_at").eq("new_status", "Active").gte("created_at", since).order("created_at", { ascending: true }).limit(200)
    if (error) { state = { ...state, lockUntil: null }; await save(state); return { enabled: true, ...zero, tableMissing: true } }
    const evs = (events ?? []) as Array<{ id: string; account_id: string; old_status: string | null; new_status: string | null; created_at: string }>
    const { data: accts } = await db().from("accounts").select("id, company_name").in("id", Array.from(new Set(evs.map((e) => e.account_id))).slice(0, 200))
    const names = new Map(((accts ?? []) as Array<{ id: string; company_name: string }>).map((a) => [a.id, a.company_name]))
    state = enqueue(state, evs, names)
    let picked = 0
    for (let i = 0; i < state.items.length; i++) {
      if (state.items[i].status !== "running") continue
      const left = opts.budgetMs - (Date.now() - t0)
      if (left < 20_000) break
      picked++
      state.items[i] = await advance(state.items[i], deps, left - 5_000)
      state = { ...state, lockUntil: new Date(Date.now() + 120_000).toISOString() }
      await save(state)
    }
    state = { ...state, lockUntil: null }
    await save(state)
    const c = (s: Item["status"]) => state.items.filter((x) => x.status === s).length
    return { enabled: true, picked, running: c("running"), done: c("done"), needsPerson: c("needs_person"), skipped: c("skipped") }
  } catch (e) {
    state = { ...state, lockUntil: null }
    await save(state).catch(() => undefined)
    throw e
  }
}
