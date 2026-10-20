/**
 * Fax — expiry of staged uploads (bug-hunter round 4, N7). A big file the browser staged under `fax-upload/` is removed by the send route on
 * every way out, but a tab closed after the upload, or a function killed at its time limit, leaves it behind — and it may be somebody's
 * identity paper. Everything older than 24 hours is deleted: by a daily cron (`/api/cron/fax-staging-sweep`) and, best effort, whenever a
 * new staged upload is requested.
 */
import { FAX_STAGING_BUCKET, FAX_STAGING_PREFIX, isFaxStagingPath } from './staged-upload'

export const STAGED_MAX_AGE_HOURS = 24

export interface StagedObject { name: string; created_at?: string | null; updated_at?: string | null }

/** Pure: the full paths of the staged objects older than `hours` (anything of another shape is never touched). */
export function staleStagedPaths(objects: StagedObject[], now: Date = new Date(), hours: number = STAGED_MAX_AGE_HOURS): string[] {
  const limit = now.getTime() - hours * 3_600_000
  const out: string[] = []
  for (const o of objects) {
    const path = `${FAX_STAGING_PREFIX}${o.name}`
    if (!isFaxStagingPath(path)) continue
    const t = Date.parse(o.created_at ?? o.updated_at ?? '')
    // an object with no readable time is treated as old: it can only be an orphan
    if (Number.isNaN(t) || t < limit) out.push(path)
  }
  return out
}

export async function sweepFaxStaging(now: Date = new Date()): Promise<{ checked: number; deleted: number; error: string | null }> {
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const bucket = supabaseAdmin.storage.from(FAX_STAGING_BUCKET)
  const { data, error } = await bucket.list(FAX_STAGING_PREFIX.replace(/\/$/, ''), { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } })
  if (error) return { checked: 0, deleted: 0, error: error.message }
  const stale = staleStagedPaths((data ?? []) as StagedObject[], now)
  if (stale.length === 0) return { checked: (data ?? []).length, deleted: 0, error: null }
  const { error: rmErr } = await bucket.remove(stale)
  return { checked: (data ?? []).length, deleted: rmErr ? 0 : stale.length, error: rmErr ? rmErr.message : null }
}
