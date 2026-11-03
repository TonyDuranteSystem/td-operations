/**
 * Bank application intake — expiry of ABANDONED temporary uploads in the private bucket `bofa-intake-uploads`
 * (Antonio 2026-11-03: "Build both" — the sweeper was left over from the bug hunt).
 *
 * An applicant's browser uploads each document straight into this bucket under `<link token>/<box>/<random>-<file name>`. Most of
 * those copies are removed by the app itself (archive.ts removes them once everything is in CRM Storage; Revoke and Reset remove a
 * link's uploads). What can be left behind: the earlier copy when an applicant swapped a document in a box, the uploads of a link
 * the applicant opened and never finished, and a copy whose removal failed. They can be passports, so once nothing needs them they
 * are deleted by a daily cron (`/api/cron/bofa-upload-sweep`).
 *
 * The rule is "delete only what provably nothing needs". An object is deleted only when ALL of these hold:
 *   - it is older than 24 hours (an upload that is happening right now is never touched);
 *   - it sits exactly at `<token>/<box>/<file>` and has a readable age;
 *   - its link row exists and is understood (an object with no row, or a row in a state we do not know, is only COUNTED, never deleted);
 *   - and one of:
 *       · the submitted application lists it but already has the file in CRM Storage (`temp_removed` + `store_file_id`);
 *       · the link is submitted, the application lists other files, and this one is not among them (a swapped-out copy);
 *       · the link was revoked, or is back to "not opened" (a reset): nobody can use what is left;
 *       · the link was opened but not finished, and it is over 35 days old: the applicant's browser cookie lasts 30 days, so after
 *         that nobody can come back to finish it (staff can only Reset it, which deletes the uploads anyway).
 * A file a submitted application still lists as its only copy (archive failed, "Save to Storage" pending) is NEVER deleted.
 *
 * CRM Storage itself (store_files / store_file_versions) is never touched here: this only ever removes objects from this one bucket.
 */

import { BOFA_BUCKET } from "./schema"

export const BOFA_SWEEP_GRACE_HOURS = 24
/** the applicant's cookie (access.ts COOKIE_MAX_AGE) lasts 30 days; 5 days of margin on top */
export const BOFA_SWEEP_OPEN_LINK_DAYS = 35
/** hard caps per run, so one run always finishes inside the function time limit */
export const BOFA_SWEEP_MAX_DELETE = 200
export const BOFA_SWEEP_MAX_LISTED = 3000

export interface SweepObject { path: string; created_at: string | null }
export interface SweepRow { token: string; status: string; opened_at?: string | null; files?: unknown }

export type DeleteWhy = "already_in_storage" | "swapped_out_copy" | "link_closed" | "link_expired"
export type KeepWhy = "too_new" | "still_needed" | "link_in_use" | "no_row" | "not_understood"

export interface SweepDecision {
  deletions: { path: string; why: DeleteWhy }[]
  kept: Record<KeepWhy, number>
  /** link tokens that have objects but no application row (counted, never deleted) */
  tokensWithoutRow: string[]
}

interface ListedFile { path?: string; temp_removed?: boolean; store_file_id?: string }

function listedFiles(row: SweepRow): ListedFile[] {
  return Array.isArray(row.files) ? (row.files as ListedFile[]).filter((f) => !!f && typeof f === "object") : []
}

/** PURE: which of the listed objects may go. Nothing is deleted unless a rule above says so. */
export function decideUploadSweep(objects: SweepObject[], rows: SweepRow[], now: Date = new Date()): SweepDecision {
  const byToken = new Map(rows.map((r) => [r.token, r]))
  const graceLimit = now.getTime() - BOFA_SWEEP_GRACE_HOURS * 3_600_000
  const openLimit = now.getTime() - BOFA_SWEEP_OPEN_LINK_DAYS * 86_400_000
  const out: SweepDecision = {
    deletions: [],
    kept: { too_new: 0, still_needed: 0, link_in_use: 0, no_row: 0, not_understood: 0 },
    tokensWithoutRow: [],
  }
  const noRow = new Set<string>()

  for (const o of objects) {
    const parts = o.path.split("/")
    if (parts.length !== 3 || parts.some((p) => !p || p === "." || p === "..")) { out.kept.not_understood++; continue }
    const created = Date.parse(o.created_at ?? "")
    if (Number.isNaN(created)) { out.kept.not_understood++; continue }
    if (created >= graceLimit) { out.kept.too_new++; continue }

    const row = byToken.get(parts[0])
    if (!row) { out.kept.no_row++; noRow.add(parts[0]); continue }

    const files = listedFiles(row)
    const entry = files.find((f) => f.path === o.path)
    if (entry) {
      // listed by the application: it is only a redundant copy once the file is safely in CRM Storage
      if (entry.temp_removed === true && typeof entry.store_file_id === "string" && entry.store_file_id) out.deletions.push({ path: o.path, why: "already_in_storage" })
      else out.kept.still_needed++
      continue
    }

    switch (row.status) {
      case "completed":
        // A submitted application always lists its required documents. If it lists none we cannot tell what it needs: keep everything.
        if (files.length === 0) out.kept.not_understood++
        else out.deletions.push({ path: o.path, why: "swapped_out_copy" })
        break
      case "revoked":
      case "pending":
        out.deletions.push({ path: o.path, why: "link_closed" })
        break
      case "opened": {
        const opened = Date.parse(row.opened_at ?? "")
        const basis = Number.isNaN(opened) ? created : opened
        if (basis < openLimit && created < openLimit) out.deletions.push({ path: o.path, why: "link_expired" })
        else out.kept.link_in_use++
        break
      }
      default:
        out.kept.not_understood++
    }
  }
  out.tokensWithoutRow = Array.from(noRow)
  return out
}

interface ListEntry { name: string; id?: string | null; created_at?: string | null }
export interface UploadSweepBucket {
  list(path: string, opts: { limit: number; offset: number; sortBy: { column: string; order: string } }): Promise<{ data: ListEntry[] | null; error: { message: string } | null }>
  remove(paths: string[]): Promise<{ error: { message: string } | null }>
}
export type ReadSweepRows = (tokens: string[]) => Promise<{ rows: SweepRow[]; error: string | null }>

export interface UploadSweepResult {
  listed: number
  wouldDelete: number
  deleted: number
  byReason: Record<DeleteWhy, number>
  kept: Record<KeepWhy, number>
  tokensWithoutRow: number
  dryRun: boolean
  capped: boolean
  error: string | null
}

const PAGE = 100

async function listAll(bucket: UploadSweepBucket, folder: string, budget: { left: number }): Promise<{ entries: ListEntry[]; error: string | null }> {
  const entries: ListEntry[] = []
  for (let offset = 0; budget.left > 0; offset += PAGE) {
    const { data, error } = await bucket.list(folder, { limit: PAGE, offset, sortBy: { column: "created_at", order: "asc" } })
    if (error) return { entries, error: error.message }
    const page = data ?? []
    entries.push(...page)
    budget.left -= page.length
    if (page.length < PAGE) break
  }
  return { entries, error: null }
}

/** Walk `<token>/<box>/<file>`: a folder entry has no id, a file entry has one. */
async function collectObjects(bucket: UploadSweepBucket, budget: { left: number }): Promise<{ objects: SweepObject[]; error: string | null }> {
  const objects: SweepObject[] = []
  const top = await listAll(bucket, "", budget)
  if (top.error) return { objects, error: top.error }
  for (const t of top.entries) {
    if (t.id) { objects.push({ path: t.name, created_at: t.created_at ?? null }); continue }
    const boxes = await listAll(bucket, t.name, budget)
    if (boxes.error) return { objects, error: boxes.error }
    for (const b of boxes.entries) {
      if (b.id) { objects.push({ path: `${t.name}/${b.name}`, created_at: b.created_at ?? null }); continue }
      const files = await listAll(bucket, `${t.name}/${b.name}`, budget)
      if (files.error) return { objects, error: files.error }
      for (const f of files.entries) if (f.id) objects.push({ path: `${t.name}/${b.name}/${f.name}`, created_at: f.created_at ?? null })
      if (budget.left <= 0) return { objects, error: null }
    }
    if (budget.left <= 0) return { objects, error: null }
  }
  return { objects, error: null }
}

async function defaultReadRows(tokens: string[]): Promise<{ rows: SweepRow[]; error: string | null }> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
  const table = () => (supabaseAdmin as any).from("bofa_intake_requests")
  const rows: SweepRow[] = []
  for (let i = 0; i < tokens.length; i += 100) {
    const { data, error } = await table().select("token, status, opened_at, files").in("token", tokens.slice(i, i + 100))
    if (error) return { rows: [], error: `Could not read the applications: ${error.message}` }
    rows.push(...((data ?? []) as SweepRow[]))
  }
  return { rows, error: null }
}

const EMPTY_REASONS = (): Record<DeleteWhy, number> => ({ already_in_storage: 0, swapped_out_copy: 0, link_closed: 0, link_expired: 0 })
const EMPTY_KEPT = (): Record<KeepWhy, number> => ({ too_new: 0, still_needed: 0, link_in_use: 0, no_row: 0, not_understood: 0 })

/**
 * Run one sweep. `bucket` and `readRows` are injectable for tests; the defaults are the private bucket and the application table
 * (service role). If the applications cannot be read, NOTHING is deleted: without them no object can be judged.
 */
export async function sweepBofaUploads(
  opts: { now?: Date; dryRun?: boolean; maxDelete?: number; maxListed?: number; bucket?: UploadSweepBucket; readRows?: ReadSweepRows } = {},
): Promise<UploadSweepResult> {
  const now = opts.now ?? new Date()
  const dryRun = opts.dryRun === true
  const maxDelete = opts.maxDelete ?? BOFA_SWEEP_MAX_DELETE
  const fail = (error: string, listed = 0): UploadSweepResult => ({ listed, wouldDelete: 0, deleted: 0, byReason: EMPTY_REASONS(), kept: EMPTY_KEPT(), tokensWithoutRow: 0, dryRun, capped: false, error })

  const bucket = opts.bucket ?? ((await import("@/lib/supabase-admin")).supabaseAdmin.storage.from(BOFA_BUCKET) as unknown as UploadSweepBucket)
  const budget = { left: opts.maxListed ?? BOFA_SWEEP_MAX_LISTED }
  const found = await collectObjects(bucket, budget)
  if (found.error) return fail(`Could not list the uploads: ${found.error}`, found.objects.length)
  const capped = budget.left <= 0
  if (found.objects.length === 0) {
    return { listed: 0, wouldDelete: 0, deleted: 0, byReason: EMPTY_REASONS(), kept: EMPTY_KEPT(), tokensWithoutRow: 0, dryRun, capped, error: null }
  }

  const tokens = Array.from(new Set(found.objects.map((o) => o.path.split("/")[0]).filter(Boolean)))
  const read = await (opts.readRows ?? defaultReadRows)(tokens)
  if (read.error) return fail(read.error, found.objects.length)

  const decision = decideUploadSweep(found.objects, read.rows, now)
  const all = decision.deletions
  const batch = all.slice(0, maxDelete)
  const byReason = EMPTY_REASONS()
  for (const d of batch) byReason[d.why]++
  const base = { listed: found.objects.length, wouldDelete: all.length, byReason, kept: decision.kept, tokensWithoutRow: decision.tokensWithoutRow.length, dryRun, capped: capped || all.length > batch.length }
  if (dryRun || batch.length === 0) return { ...base, deleted: 0, error: null }

  let deleted = 0
  let error: string | null = null
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100).map((d) => d.path)
    const { error: rmErr } = await bucket.remove(chunk)
    if (rmErr) { error = `Could not remove some uploads: ${rmErr.message}`; break }
    deleted += chunk.length
  }
  return { ...base, deleted, error }
}
