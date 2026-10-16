/**
 * Drive-vs-storage gap check, run by a cron — no button (dev job ad09ea91; Antonio 2026-10-16: "I don't want any button … check in the
 * old Drive what files are not in our storage, without everything we decided to leave there").
 *
 * READ-ONLY toward Drive, storage and the CRM. Each run checks a few companies (their old Drive folder against what the moves already
 * decided + storage + the CRM) and keeps its progress and the result in ONE sysdoc row, `drive-gap-report`, which a person (or Claude)
 * reads. When every company has been checked the status becomes `done` and later runs do nothing.
 *
 * Switched on with STORE_DRIVE_GAP=1 (default OFF).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listGapCompanies, scanCompanyGap } from "./drive-gap"

export const GAP_SLUG = "drive-gap-report"

export interface GapState {
  status: "running" | "done"
  startedAt: string
  updatedAt: string
  lockUntil: string | null
  total: number
  checked: number
  /** companies not yet checked, in order */
  queue: string[]
  /** companies that could not be read, with the reason */
  failed: Array<{ company: string; why: string }>
  /** per company, ONLY the files that are in the Drive folder and nowhere else (the move never saw them) */
  results: Array<{ accountId: string; company: string; driveTotal: number; files: Array<{ name: string; path: string; size: number | null }> }>
}

export function gapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.STORE_DRIVE_GAP ?? "").trim() === "1"
}

export function stillLocked(state: GapState, now: Date = new Date()): boolean {
  return !!state.lockUntil && Date.parse(state.lockUntil) > now.getTime()
}

/** Pure: fold one company's report into the state. */
export function applyReport(state: GapState, accountId: string, company: string, report: { total: number; files: Array<{ name: string; path: string; kind: string; size: number | null }> } | { error: string }): GapState {
  const queue = state.queue.filter((id) => id !== accountId)
  if ("error" in report) return { ...state, queue, checked: state.checked + 1, failed: [...state.failed, { company, why: report.error }] }
  const missing = report.files.filter((f) => f.kind === "missing").map((f) => ({ name: f.name, path: f.path, size: f.size }))
  return {
    ...state,
    queue,
    checked: state.checked + 1,
    results: missing.length ? [...state.results, { accountId, company, driveTotal: report.total, files: missing }] : state.results,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- system_docs row shape
const sys = () => supabaseAdmin as any

async function load(): Promise<GapState | null> {
  const { data, error } = await sys().from("system_docs").select("content").eq("slug", GAP_SLUG).maybeSingle()
  if (error) throw new Error("Could not read the Drive check state.")
  if (!data?.content) return null
  try { return JSON.parse(data.content as string) as GapState } catch { return null }
}

async function save(state: GapState): Promise<void> {
  const row = { slug: GAP_SLUG, title: "Drive check: old Drive files not in storage", doc_type: "report", content: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), agent_readable: false, updated_at: new Date().toISOString() }
  const { error } = await sys().from("system_docs").upsert(row, { onConflict: "slug" })
  if (error) throw new Error("Could not save the Drive check.")
}

export async function runGapBatch(opts: { budgetMs: number }): Promise<{ status: string; checked: number; total: number }> {
  const t0 = Date.now()
  let state = await load()
  if (state?.status === "done") return { status: "done", checked: state.checked, total: state.total }
  if (!state) {
    const companies = await listGapCompanies()
    state = { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lockUntil: null, total: companies.length, checked: 0, queue: companies.map((c) => c.accountId), failed: [], results: [] }
  }
  if (stillLocked(state)) return { status: "busy", checked: state.checked, total: state.total }
  state = { ...state, lockUntil: new Date(Date.now() + opts.budgetMs + 60_000).toISOString() }
  await save(state)
  const names = new Map((await listGapCompanies()).map((c) => [c.accountId, c.company]))
  while (state.queue.length && Date.now() - t0 < opts.budgetMs) {
    const id = state.queue[0]
    const company = names.get(id) ?? id
    try {
      state = applyReport(state, id, company, await scanCompanyGap(id))
    } catch (e) {
      state = applyReport(state, id, company, { error: e instanceof Error ? e.message : String(e) })
    }
    await save(state)
  }
  state = { ...state, lockUntil: null, status: state.queue.length ? "running" : "done" }
  await save(state)
  return { status: state.status, checked: state.checked, total: state.total }
}
