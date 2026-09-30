/**
 * File Understanding — background reading of ONE stored file version (job 685467b5). Default OFF: unless
 * STORE_ANALYSIS_ENABLED=1 the job does nothing and says so. One row per (version, analyzer version) makes a second
 * run free; a file that cannot be read is a FINAL result (no retries burning money): max_attempts is 1.
 */
import type { Job, JobResult } from "../queue"

export async function handleStoreFileAnalyze(job: Job): Promise<JobResult> {
  const { analysisEnabled, analyzeVersion } = await import("@/lib/crm-store/understand/analyze")
  const payload = job.payload as unknown as { version_id: string; actor?: string | null }
  const at = new Date().toISOString()
  if (!analysisEnabled()) return { steps: [{ name: "analyze", status: "skipped", detail: "switched off", timestamp: at }], summary: "File analysis is switched off." }
  const r = await analyzeVersion(payload.version_id, { actor: payload.actor ?? null, withAi: true })
  return { steps: [{ name: "analyze", status: "ok", detail: `${r.status} ${r.verdict ?? ""} ${r.reused ? "(already done)" : ""}`.trim(), timestamp: at }], summary: `${payload.version_id}: ${r.status} ${r.verdict ?? ""}` }
}
