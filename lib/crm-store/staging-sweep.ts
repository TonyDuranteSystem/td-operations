/**
 * Expiry of the temporary upload area `crm-uploads/store-staging/` in the bucket `onboarding-uploads` (security hunt 2026-10-25).
 *
 * Every staff upload into the CRM Storage library (and every "new version") is first put there by the browser, then registered, then
 * the server copies it into the library. A tab closed after the upload, a failed retry (lib/storage/put-with-retry.ts leaves a
 * half-written first copy behind on purpose) or a killed function leaves the temporary copy for ever — and it can be a passport.
 * Anything older than 24 hours is deleted: by a daily cron (`/api/cron/store-staging-sweep`). Paths look like
 * `crm-uploads/store-staging/<ownerId>/<timestamp>_<random>_<name>` (one folder level), so the sweep walks owner folders.
 */

export const STORE_STAGING_SWEEP_BUCKET = "onboarding-uploads"
export const STORE_STAGING_SWEEP_PREFIX = "crm-uploads/store-staging/"
export const STORE_STAGING_MAX_AGE_HOURS = 24
/** hard caps per run, so one run always finishes inside the function time limit */
export const STORE_STAGING_MAX_DELETE = 500
export const STORE_STAGING_MAX_LISTED = 5000

export interface StagedObject { path: string; created_at?: string | null }

/** Pure: the paths older than `hours`. Anything outside the prefix, containing "..", or with no readable time is never touched. */
export function staleStagingPaths(objects: StagedObject[], now: Date = new Date(), hours: number = STORE_STAGING_MAX_AGE_HOURS): string[] {
  const limit = now.getTime() - hours * 3_600_000
  const out: string[] = []
  for (const o of objects) {
    if (!o.path.startsWith(STORE_STAGING_SWEEP_PREFIX) || o.path.includes("..") || o.path.endsWith("/")) continue
    const t = Date.parse(o.created_at ?? "")
    if (!Number.isNaN(t) && t < limit) out.push(o.path)
  }
  return out
}

interface ListEntry { name: string; id?: string | null; created_at?: string | null }
export interface SweepBucket {
  list(path: string, opts: { limit: number; offset: number; sortBy: { column: string; order: string } }): Promise<{ data: ListEntry[] | null; error: { message: string } | null }>
  remove(paths: string[]): Promise<{ error: { message: string } | null }>
}

export interface StagingSweepResult { listed: number; stale: number; deleted: number; dryRun: boolean; capped: boolean; error: string | null }

const PAGE = 100

async function listAll(bucket: SweepBucket, folder: string, budget: { left: number }): Promise<{ entries: ListEntry[]; error: string | null }> {
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

/** `bucket` is injectable for tests; the default is the private onboarding-uploads bucket (service role). */
export async function sweepStoreStaging(opts: { now?: Date; dryRun?: boolean; maxDelete?: number; maxListed?: number; bucket?: SweepBucket } = {}): Promise<StagingSweepResult> {
  const now = opts.now ?? new Date()
  const dryRun = opts.dryRun === true
  const maxDelete = opts.maxDelete ?? STORE_STAGING_MAX_DELETE
  const bucket = opts.bucket ?? ((await import("@/lib/supabase-admin")).supabaseAdmin.storage.from(STORE_STAGING_SWEEP_BUCKET) as unknown as SweepBucket)
  const budget = { left: opts.maxListed ?? STORE_STAGING_MAX_LISTED }
  const root = STORE_STAGING_SWEEP_PREFIX.replace(/\/$/, "")
  const top = await listAll(bucket, root, budget)
  if (top.error) return { listed: 0, stale: 0, deleted: 0, dryRun, capped: false, error: top.error }
  const objects: StagedObject[] = []
  let error: string | null = null
  for (const e of top.entries) {
    if (e.id) { objects.push({ path: `${STORE_STAGING_SWEEP_PREFIX}${e.name}`, created_at: e.created_at }); continue } // a file directly under the prefix
    const inner = await listAll(bucket, `${root}/${e.name}`, budget)
    for (const f of inner.entries) if (f.id) objects.push({ path: `${STORE_STAGING_SWEEP_PREFIX}${e.name}/${f.name}`, created_at: f.created_at })
    if (inner.error) { error = inner.error; break }
    if (budget.left <= 0) break
  }
  const allStale = staleStagingPaths(objects, now)
  const stale = allStale.slice(0, maxDelete)
  const capped = allStale.length > stale.length || budget.left <= 0
  if (dryRun || stale.length === 0) return { listed: objects.length, stale: allStale.length, deleted: 0, dryRun, capped, error }
  const { error: rmErr } = await bucket.remove(stale)
  return { listed: objects.length, stale: allStale.length, deleted: rmErr ? 0 : stale.length, dryRun, capped, error: rmErr ? rmErr.message : error }
}
