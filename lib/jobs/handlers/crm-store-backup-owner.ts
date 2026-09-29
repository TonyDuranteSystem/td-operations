/**
 * Background backup of ONE store owner into Google Drive (slice 5, job 685467b5). Queued by
 * sweepBackups() (not scheduled yet — dark; the kill switch STORE_BACKUP_ENABLED is off by default).
 * The run stops cleanly before the runner's deadline ("deferred": work so far is kept, the owner stays
 * due for the next run, the runner stops claiming). A lease held by another worker ends quietly. A failed
 * run is recorded on the owner's backup state (the completeness alarm reports it) and retried.
 */

import type { Job, JobResult } from "../queue"
import type { JobRunContext } from "../registry"

export async function handleCrmStoreBackupOwner(job: Job, ctx?: JobRunContext): Promise<JobResult> {
  const { backupOwner } = await import("@/lib/crm-store/backup")
  const payload = job.payload as unknown as { owner_id: string; full_check?: boolean }
  const r = await backupOwner(payload.owner_id, { fullCheck: !!payload.full_check, deadlineAt: ctx?.deadlineAt })
  if (r.status === "failed") throw new Error(`store backup of ${payload.owner_id} failed: ${r.error}`)
  return {
    steps: [{ name: "backup_owner", status: r.status === "done" || r.status === "deferred" ? "ok" : "skipped", detail: JSON.stringify(r), timestamp: new Date().toISOString() }],
    summary: `backup ${payload.owner_id} → ${r.status} (${r.uploaded} new, ${r.updated} updated, ${r.moved} moved, ${r.protectedMoves} protected, ${r.recreated} recreated, ${r.removed} removed)`,
    deferRunner: r.status === "deferred" ? true : undefined,
  }
}
